/**
 * Real Harness Loader composition: boundary compaction reaches the member's own
 * compaction realm.
 *
 * Both supported web profiles disable the host-plane `compaction-basic` row and
 * mount it, with `/compact`, inside an agent preset's `cordis:group` that
 * isolates the `compaction` service. This composition mounts that same realm
 * (the preset's rows and `isolate` map) beside the host-plane `commands` and
 * `tokenMeter` services, so the plugin cannot see the engine through
 * `ctx.get('compaction')` any more than it can under a preset. Only the model
 * boundary is scripted: it reports prompts above a low `boundaryCompactionTokens`
 * and answers the engine's summary request. The builder is idle at its
 * verdict; the reviewer is still inside `swarm_verify` and compacts at its next
 * idle. Each must compact after the verdict and before its next assignment, and
 * its next request must carry the checkpoint instead of the old history.
 */
import { resolveHarnessRoot, assertSupportedHarness } from '../scripts/harness-target.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { bootHarness, harnessEntry, importHarness, toolResultBlocks } from './fixtures/built-harness.mjs'
import { requests, setResponder } from './fixtures/scripted-llm.mjs'

const execute = promisify(execFile)
const project = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const argument = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const artifactRoot = resolve(argument('--artifact', project))
const harnessRoot = resolveHarnessRoot(argument('--harness', undefined))
assertSupportedHarness(harnessRoot)
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'dsh-swarm-compaction-')))
const workspace = join(temporary, 'workspace')
const runRoot = join(temporary, 'runtime')
const ownerId = 'swarm-compaction-owner'
const THRESHOLD = 1000
/** Every member request reports a prompt above THRESHOLD, so each verdict is a compaction boundary. */
const MEMBER_USAGE = { inputTokens: 1500, outputTokens: 8 }
const SUMMARY_USAGE = { inputTokens: 700, outputTokens: 30 }
const texts = message => message.content.filter(block => block.type === 'text').map(block => block.text)
const failures = []
const scripts = new Map()
const handledOwnerCommands = new Set()
/** Provider usage the scripted model reported, per session: what the member's accounting must equal. */
const reported = new Map()
let ctx
let ownerHandle
let commandCounter = 0

function report(sessionId, usage) {
  const total = reported.get(sessionId) ?? { requests: 0, inputTokens: 0, outputTokens: 0 }
  total.requests += 1; total.inputTokens += usage.inputTokens; total.outputTokens += usage.outputTokens
  reported.set(sessionId, total)
  return usage
}

setResponder(options => {
  try {
    if (options.purpose === 'compaction') {
      return { kind: 'text', text: '## Primary Request and Intent\n- Deliver value two.\n## Current Work\n- (none)', usage: report(options.sessionId, SUMMARY_USAGE) }
    }
    if (options.sessionId === ownerId) {
      const command = options.messages.flatMap(texts).findLast(text => text.startsWith('SMOKE_OWNER '))
      if (command && !handledOwnerCommands.has(command)) {
        handledOwnerCommands.add(command)
        const { name, args } = JSON.parse(command.slice(command.indexOf('{')))
        return { kind: 'tool', name, args }
      }
      return { kind: 'text', text: 'Owner turn complete.' }
    }
    const usage = report(options.sessionId, MEMBER_USAGE)
    const assignment = options.messages.findLast(message => message.source?.kind === 'swarm' && message.source.deliveryKind === 'assignment')
    if (!assignment) return { kind: 'text', text: 'Waiting for an assigned task.', usage }
    const source = assignment.source
    let script = scripts.get(options.sessionId)
    if (!script || script.deliveryId !== source.deliveryId) {
      script = { deliveryId: source.deliveryId, stage: 'work' }
      scripts.set(options.sessionId, script)
      return { kind: 'tool', name: 'swarm_observe', args: { missionId: source.missionId }, usage }
    }
    if (script.stage === 'done') return { kind: 'text', text: 'Unit finished; waiting for new work.', usage }
    const view = toolResultBlocks(options.messages).map(block => { try { return JSON.parse(texts(block).join('\n')).result } catch { return undefined } })
      .findLast(result => result?.current?.task !== undefined)
    const task = view?.current?.task
    assert(task?.status === 'running', 'the assignment must lead to a model-visible observation of the running task')
    const current = { missionId: source.missionId, taskId: task.id, attemptId: task.attempt.id }
    if (task.kind === 'verification') {
      script.stage = 'done'
      return { kind: 'tool', name: 'swarm_verify', args: { ...current, verdict: 'accept', reason: 'The declared check passes on the exact submitted artifact.' }, usage }
    }
    if (script.stage === 'work') {
      script.stage = 'submit'
      return { kind: 'tool', name: 'bash', args: { command: "printf 'module.exports = 2\\n' > value.cjs && node check.cjs", description: 'Make the value two and check it.' }, usage }
    }
    script.stage = 'done'
    return { kind: 'tool', name: 'swarm_submit', args: { ...current, output: 'The value is two and the declared check passes.' }, usage }
  } catch (error) {
    failures.push(error)
    return { kind: 'text', text: `Fixture assertion failed: ${error.message}` }
  }
})

async function waitUntil(predicate, description, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (failures.length) throw failures[0]
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out after ${timeout}ms: ${description}`)
}

async function ownerCall(name, args) {
  const firstSeq = ownerHandle.agent.session.snapshotEvents().length
  const { createUserMessage } = await importHarness(harnessRoot, '@deepseek-ai/dsh-llm')
  ownerHandle.agent.followup(createUserMessage({ content: [{ type: 'text', text: `SMOKE_OWNER ${++commandCounter} ${JSON.stringify({ name, args })}` }], source: { kind: 'user' } }))
  await ownerHandle.agent.whenIdle()
  if (failures.length) throw failures[0]
  const result = ownerHandle.agent.session.snapshotEvents().slice(firstSeq).filter(event => event.type === 'tool/result').flatMap(event => toolResultBlocks([event.data.message]))[0]
  assert(result && !result.isError, `${name} failed: ${result && texts(result).join('\n')}`)
  return JSON.parse(texts(result).join('\n')).result
}

const taskStatus = (missionId, taskId) => ctx.swarm.snapshot({ sessionId: ownerId }, missionId).tasks.find(task => task.id === taskId)?.status

/**
 * The member's session log around one boundary: exactly one compaction after
 * the verdict and before the next assignment reached the model, run while no
 * turn was open, and not attributed to a command.
 */
function assertBoundaryCompaction(member, verdictAt, nextAssignment) {
  const events = ctx.agents.get(member.agentId).session.snapshotEvents()
  const delivered = events.findIndex(event => event.type === 'user/message' && event.data.source?.deliveryKind === 'assignment' && event.data.source.deliveryId === nextAssignment)
  assert(delivered > 0, `${member.name} must receive its next assignment`)
  const starts = events.slice(0, delivered).filter(event => event.type === 'compaction/start')
  assert.equal(starts.length, 1, `${member.name} must compact exactly once between its verdict and its next assignment (no compaction reached the member's realm)`)
  const start = events.indexOf(starts[0])
  const end = events.findIndex((event, index) => index > start && event.type === 'compaction/end')
  assert(end > start && events[end].data.error === undefined, `${member.name}'s compaction must complete`)
  assert(events.slice(start, end).some(event => event.type === 'compaction/summary'), `${member.name}'s compaction must land a summary`)
  assert.equal(starts[0].data.sourceCommandId, undefined, 'a boundary compaction is not a human command')
  assert(starts[0].time >= verdictAt, `${member.name} must compact after its verdict`)
  const openTurns = events.slice(0, start).filter(event => event.type === 'turn/start').length - events.slice(0, start).filter(event => event.type === 'turn/end').length
  assert.equal(openTurns, 0, `${member.name} must compact only while idle`)
  assert(!events.slice(start, end).some(event => event.type === 'turn/start'), `${member.name}'s next unit must wait for the compaction`)
  assert(delivered > end, `${member.name} must compact before its next assignment reaches the model`)
}

/** The member's next request is smaller than its last one before the boundary and carries the checkpoint. */
function assertSmallerNextRequest(member) {
  const own = requests.filter(request => request.sessionId === member.sessionId)
  const summary = own.findIndex(request => request.purpose === 'compaction')
  const before = own.slice(0, summary).findLast(request => request.purpose !== 'compaction')
  const after = own.slice(summary + 1).find(request => request.purpose !== 'compaction')
  assert(before && after, `${member.name} must make requests on both sides of its compaction`)
  const size = request => JSON.stringify(request.messages).length
  assert(after.messages.length < before.messages.length && size(after) < size(before),
    `${member.name}'s next request must be smaller: ${before.messages.length} messages (${size(before)} chars) before, ${after.messages.length} (${size(after)}) after`)
  assert(after.messages.some(message => texts(message).join('\n').includes('<compacted-summary>')), `${member.name}'s next request must carry the checkpoint`)
}

try {
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'value.cjs'), 'module.exports = 1\n')
  await writeFile(join(workspace, 'check.cjs'), "require('node:assert/strict').equal(require('./value.cjs'), 2); console.log('VERIFIED_TWO')\n")
  for (const gitArgs of [
    ['init', '--quiet'], ['config', 'user.name', 'Swarm Smoke'], ['config', 'user.email', 'swarm-smoke@example.invalid'],
    ['add', '.'], ['commit', '--quiet', '-m', 'fixture baseline'],
  ]) await execute('git', gitArgs, { cwd: workspace })
  // The preset realm, verbatim in shape: the engine and its command inside a group isolating `compaction`.
  const realm = {
    id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true, toolResultPruner: true },
    config: [
      { id: 'compaction-basic', name: await harnessEntry(harnessRoot, '@deepseek-ai/dsh-compaction-basic') },
      { id: 'command-compact', name: await harnessEntry(harnessRoot, '@deepseek-ai/dsh-command-compact') },
    ],
  }
  ctx = await bootHarness({
    harnessRoot, artifactRoot, runRoot, workspace,
    extraRows: [['commands', '@deepseek-ai/dsh-commands'], ['token-meter', '@deepseek-ai/dsh-token-meter'], realm],
    swarmConfig: {
      statePath: join(runRoot, 'swarm.sqlite'), workspacesRoot: join(runRoot, 'worktrees'),
      tickMs: 20, leaseMs: 30_000, checkTimeoutMs: 30_000, maxCheckOutputBytes: 16_000, boundaryCompactionTokens: THRESHOLD,
    },
  })
  assert.equal(ctx.get('compaction'), undefined, 'the realm isolates the engine from the host plane, as an agent preset does')
  const { SessionId } = await importHarness(harnessRoot, '@deepseek-ai/dsh-session')
  ownerHandle = await ctx.agents.create({ sessionId: SessionId(ownerId), meta: { cwd: workspace }, agentOptions: { provider: 'swarm-smoke', model: 'swarm-smoke' } })
  const budget = { maxTokens: 2_000_000, maxSteps: 200, maxWorkers: 3, maxDurationMs: 120_000, maxTasks: 20, maxExperiments: 3 }
  const mission = await ownerCall('swarm_create', { title: 'Boundary compaction', objective: 'Deliver value two across two units per member.', workspace, scope: ['value.cjs'], acceptance: ['value is two'], budget })
  const missionId = mission.id
  const stream = await ownerCall('swarm_workstream', { missionId, title: 'Value', objective: 'Implement, integrate and review value two.' })
  const builder = await ownerCall('swarm_add_member', { missionId, name: 'builder', role: 'implementation and integration' })
  const reviewer = await ownerCall('swarm_add_member', { missionId, name: 'reviewer', role: 'independent verifier' })
  builder.agentId = SessionId(builder.sessionId); reviewer.agentId = SessionId(reviewer.sessionId)
  assert(ctx.commands.find(ctx.agents.get(builder.agentId), 'compact'), 'the realm registers /compact for the member')
  const work = { missionId, workstreamId: stream.id, scope: ['value.cjs'], acceptance: ['value is two'] }

  const implementation = await ownerCall('swarm_propose', { ...work, title: 'Implement value two', objective: 'Change value.cjs to export two.', kind: 'implementation', outputs: ['value.cjs'], checks: ['node check.cjs'], assigneeId: builder.id })
  await waitUntil(() => taskStatus(missionId, implementation.id) === 'submitted' && ctx.agents.get(builder.agentId).status === 'idle', 'implementation submitted and the builder idle')
  await ownerCall('swarm_propose', { ...work, title: 'Review value two', objective: 'Review the submitted artifact.', kind: 'verification', reviewOf: implementation.id, outputs: [], assigneeId: reviewer.id })
  await waitUntil(() => taskStatus(missionId, implementation.id) === 'accepted', 'the first verdict')
  const firstVerdictAt = ctx.swarm.snapshot({ sessionId: ownerId }, missionId).events.find(event => event.type === 'task/accepted' && event.data.sourceTaskId === implementation.id).createdAt
  await waitUntil(() => [builder, reviewer].every(member => ctx.agents.get(member.agentId).session.snapshotEvents().some(event => event.type === 'compaction/end')), 'both members compact at the boundary', 20_000)

  const integration = await ownerCall('swarm_propose', { ...work, title: 'Integrate value two', objective: 'Integrate the accepted value.', kind: 'integration', dependencies: [implementation.id], outputs: ['value.cjs'], checks: ['node check.cjs'], assigneeId: builder.id })
  await waitUntil(() => taskStatus(missionId, integration.id) === 'submitted', 'integration submitted')
  const secondReview = await ownerCall('swarm_propose', { ...work, title: 'Review the integration', objective: 'Review the integrated artifact.', kind: 'verification', reviewOf: integration.id, outputs: [], assigneeId: reviewer.id })
  await waitUntil(() => taskStatus(missionId, integration.id) === 'accepted', 'the second verdict')

  const assignmentOf = taskId => ctx.swarm.snapshot({ sessionId: ownerId }, missionId).tasks.find(task => task.id === taskId).attempt?.id
  const deliveries = ctx.swarm.store.list('deliveries', missionId).filter(delivery => delivery.kind === 'assignment')
  const nextAssignment = taskId => deliveries.find(delivery => delivery.taskId === taskId && delivery.attemptId === assignmentOf(taskId))?.id
  assertBoundaryCompaction(builder, firstVerdictAt, nextAssignment(integration.id))
  assertBoundaryCompaction(reviewer, firstVerdictAt, nextAssignment(secondReview.id))
  // The reviewer's verdict landed inside its swarm_verify call: the request waited for that turn to end.
  const reviewerEvents = ctx.agents.get(reviewer.agentId).session.snapshotEvents()
  const verifyCall = reviewerEvents.findIndex(event => event.type === 'tool/call' && event.data.name === 'swarm_verify')
  const reviewerCompaction = reviewerEvents.findIndex(event => event.type === 'compaction/start')
  assert(verifyCall >= 0 && reviewerEvents.slice(verifyCall, reviewerCompaction).some(event => event.type === 'turn/end'), 'the reviewer compacts at the idle after its verdict turn, not inside it')
  assertSmallerNextRequest(builder)
  assertSmallerNextRequest(reviewer)
  // The summary request is charged to the member like any request.
  for (const member of [builder, reviewer]) {
    const expected = reported.get(member.sessionId)
    await waitUntil(() => ctx.swarm.store.get('members', member.id).usage?.requests === expected.requests, `${member.name}'s usage includes its summary request`, 10_000)
    const usage = ctx.swarm.store.get('members', member.id).usage
    assert.deepEqual({ requests: usage.requests, inputTokens: usage.uncachedInputTokens, outputTokens: usage.outputTokens }, expected, `${member.name} is charged for every request, the summary included`)
  }
  process.stdout.write('Real Harness Loader boundary compaction passed: the preset-isolated engine compacted the idle builder at its verdict and the reviewer at its next idle, before each next assignment; both next requests carried the checkpoint and were smaller; the summaries were accounted.\n')
} finally {
  await ownerHandle?.dispose()
  await ctx?.fiber.dispose()
  await rm(temporary, { recursive: true, force: true })
}
