import { resolveHarnessRoot, assertSupportedHarness } from '../scripts/harness-target.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { bootHarness, importHarness } from './fixtures/built-harness.mjs'
import { requests, setResponder } from './fixtures/scripted-llm.mjs'

const execute = promisify(execFile)
const project = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const argument = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const artifactRoot = resolve(argument('--artifact', project))
const harnessRoot = resolveHarnessRoot(argument('--harness', undefined))
const bundleProfile = argument('--bundle-profile', undefined)
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'dsh-swarm-loader-')))
const workspace = join(temporary, 'workspace')
const runRoot = join(temporary, 'runtime')
const ownerId = 'swarm-smoke-owner'
const failures = []
const scripts = new Map()
const handledOwnerCommands = new Set()
const waitingSessions = new Set()
const userMessages = []
const transcript = []
const recentTools = []
const fixtureStarted = Date.now()
let ctx
let ownerHandle
let commandCounter = 0
let workerMode = 'complete'

const tool = (name, args) => ({ kind: 'tool', name, args })
const answer = text => ({ kind: 'text', text })
const texts = message => message.content.filter(block => block.type === 'text').map(block => block.text)
const toolBlocks = messages => messages.flatMap(message => message.content.filter(block => block.type === 'tool-result'))
function jsonResult(block) {
  const rendered = texts(block).join('\n')
  assert(!block.isError, `Harness tool failed: ${rendered}`)
  return JSON.parse(rendered)
}
function latestObservation(messages) {
  for (const block of toolBlocks(messages).toReversed()) {
    if (block.isError) continue
    let body
    try { body = JSON.parse(texts(block).join('\n')) } catch { continue }
    if (body.result?.member !== undefined) return body
  }
  return undefined
}

setResponder(options => {
  try {
    const previous = toolBlocks(options.messages).at(-1)
    if (previous?.isError) throw new Error(`model observed tool error: ${texts(previous).join('\n')}`)
    if (options.sessionId === ownerId) {
      const command = options.messages.flatMap(texts).findLast(text => text.startsWith('SMOKE_OWNER '))
      if (command && !handledOwnerCommands.has(command)) {
        handledOwnerCommands.add(command)
        const { name, args } = JSON.parse(command.slice(command.indexOf('{')))
        return tool(name, args)
      }
      return answer('Owner turn complete.')
    }
    const assignment = options.messages.findLast(message => message.source?.kind === 'swarm' && message.source.deliveryKind === 'assignment')
    if (!assignment) return answer('Waiting for an assigned task.')
    const source = assignment.source
    let script = scripts.get(options.sessionId)
    if (!script || script.deliveryId !== source.deliveryId) {
      script = { deliveryId: source.deliveryId, stage: 'work' }
      scripts.set(options.sessionId, script)
      return tool('swarm_observe', { missionId: source.missionId })
    }
    if (workerMode === 'wait') { waitingSessions.add(options.sessionId); return { kind: 'wait' } }
    if (script.stage === 'done') return answer('Assignment finished; waiting for new work.')
    const observed = latestObservation(options.messages)
    assert(observed, 'assignment must lead to a model-visible focused observation')
    const view = observed.result
    const member = view.member
    assert(member?.id, 'model-visible observation must identify the authenticated worker')
    assert(view.current?.task?.status === 'running' && view.current.task.attempt?.ownerId === member.id, 'model-visible observation must contain the current owned attempt')
    const task = view.current.task
    assert(!('snapshot' in observed), 'the complete board must not be repeated in the model-visible text')
    const current = { missionId: source.missionId, taskId: task.id, attemptId: task.attempt.id }
    if (task.kind === 'verification') {
      script.stage = 'done'
      return tool('swarm_verify', { ...current, verdict: 'accept', reason: 'The independent host checks validate the exact submitted artifact.' })
    }
    if (script.stage === 'work') {
      script.stage = 'record'
      return tool('bash', {
        command: task.kind === 'implementation'
          ? "printf 'module.exports = 2\\n' > value.cjs && node check.cjs"
          : 'node check.cjs',
        description: task.kind === 'implementation' ? 'Implement the scoped change and check it.' : 'Check the accepted dependency in the integration worktree.',
      })
    }
    if (script.stage === 'record') {
      script.stage = 'publish'
      return tool('swarm_observe', { missionId: source.missionId })
    }
    if (script.stage === 'publish') {
      const runs = view.toolRuns
      assert(Array.isArray(runs), 'observe must expose the worker’s host-recorded tool runs')
      const supporting = runs.filter(run => run.taskId === task.id && run.tool === 'bash' && !run.isError)
      assert(supporting.length > 0, 'real bash result must be available as evidence')
      // The bash result itself already carried the citable run id; observation must agree with it.
      const bashResult = toolBlocks(options.messages).toReversed().find(block => texts(block).join('\n').includes('[swarm toolRunId: '))
      assert(bashResult, 'each recorded tool result must end with its host run id')
      const citedInResult = texts(bashResult).join('\n').match(/\[swarm toolRunId: (run_[^\]]+)\]/)[1]
      assert(supporting.some(run => run.id === citedInResult), 'the run id appended to the tool result must be the recorded run')
      script.stage = 'request-review'
      return tool('swarm_publish', {
        ...current, claim: 'The committed fixture produces the required value of two.', outcome: 'supported', toolRunIds: supporting.map(run => run.id),
      })
    }
    if (script.stage === 'request-review') {
      const reviewer = view.members.find(candidate => candidate.id !== member.id && candidate.role === 'independent verifier')
      assert(reviewer, 'the worker must discover its peer from the board')
      script.stage = 'review'
      return tool('swarm_message', {
        missionId: source.missionId, to: reviewer.id, kind: 'question',
        content: 'Independent review requested; use the board and review only the current submitted artifact.',
      })
    }
    if (script.stage === 'review') {
      const reviewer = view.members.find(candidate => candidate.id !== member.id && candidate.role === 'independent verifier')
      assert(reviewer, 'the worker must discover its peer from the board')
      script.stage = 'submit'
      return tool('swarm_propose', {
        missionId: source.missionId, workstreamId: task.workstreamId,
        title: `Independent review: ${task.title}`, objective: 'Review the submitted artifact and run its required checks.',
        kind: 'verification', reviewOf: task.id, assigneeId: reviewer.id,
        scope: task.scope, acceptance: task.acceptance,
      })
    }
    if (script.stage === 'submit') {
      script.stage = 'done'
      return tool('swarm_submit', { ...current, output: 'The value is two; the real check passes and the evidence references its host execution.' })
    }
    throw new Error(`Unknown worker script stage ${script.stage}`)
  } catch (error) {
    failures.push(error)
    return answer(`Fixture assertion failed: ${error.message}`)
  }
})

async function waitUntil(predicate, description, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (failures.length) { writeFailureDiagnostics(description); throw failures[0] }
    try { if (await predicate()) return }
    catch (error) { writeFailureDiagnostics(description); throw error }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  writeFailureDiagnostics(description)
  throw new Error(`Timed out after ${timeout}ms: ${description}`)
}

/** Small fixture-owned state only; no raw prompts, options, environment or keys. */
function writeFailureDiagnostics(description) {
  const safe = (value, depth = 0) => {
    if (typeof value === 'string') return value.replaceAll(temporary, '<fixture>').replaceAll(harnessRoot, '<harness>')
      .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>').slice(0, 600)
    if (value === null || typeof value !== 'object') return value
    if (depth > 3) return '<nested>'
    if (Array.isArray(value)) return value.slice(-15).map(item => safe(item, depth + 1))
    return Object.fromEntries(Object.entries(value).slice(0, 24).map(([key, item]) => [key,
      /api.?key|secret|password|authorization/i.test(key) ? '<redacted>' : safe(item, depth + 1)]))
  }
  const snapshots = ctx?.get('swarm') ? ctx.swarm.list(ownerId).map(mission => {
    const snapshot = ctx.swarm.snapshot({ sessionId: ownerId }, mission.id)
    return {
      mission: { id: mission.id, status: mission.status, reason: mission.reason, usedSteps: mission.usedSteps, usedTokens: mission.usedTokens, remainingMs: mission.deadline - Date.now() },
      members: snapshot.members.map(member => ({ id: member.id, sessionId: member.sessionId, name: member.name, status: member.status })),
      tasks: snapshot.tasks.map(task => ({ id: task.id, title: task.title, kind: task.kind, status: task.status, output: task.output, handoff: task.handoff,
        attempt: task.attempt && { id: task.attempt.id, ownerId: task.attempt.ownerId, remainingLeaseMs: task.attempt.leaseUntil - Date.now() } })),
      events: snapshot.events.slice(-15),
    }
  }) : []
  const agents = ctx?.get('agents') ? ctx.agents.list().map(agent => ({ id: agent.id, status: agent.status, pending: agent.inbox.hasPending })) : []
  process.stderr.write(`Loader fixture diagnostics: ${JSON.stringify({ description, elapsedMs: Date.now() - fixtureStarted, snapshots: safe(snapshots), agents, recentTools: safe(recentTools.slice(-24)), scripts: safe([...scripts]), modelRequests: requests.length }, null, 2)}\n`)
}

async function ownerCall(name, args) {
  const firstSeq = ownerHandle.agent.session.snapshotEvents().length
  const { createUserMessage } = await importHarness(harnessRoot, '@deepseek-ai/dsh-llm')
  ownerHandle.agent.followup(createUserMessage({
    content: [{ type: 'text', text: `SMOKE_OWNER ${++commandCounter} ${JSON.stringify({ name, args })}` }],
    source: { kind: 'user' },
  }))
  await ownerHandle.agent.whenIdle()
  if (failures.length) throw failures[0]
  const events = ownerHandle.agent.session.snapshotEvents().slice(firstSeq)
  const call = events.find(event => event.type === 'tool/call' && event.data.name === name)
  assert(call, `${name} must execute through the owner’s actual model/tool loop`)
  const results = events.filter(event => event.type === 'tool/result').flatMap(event => toolBlocks([event.data.message]))
  assert(results.length > 0, `${name} must be logged with its model-facing result`)
  return jsonResult(results[0])
}

function attachTranscript(context) {
  context.on('session/event', (session, event) => {
    if (event.type === 'user/message' && event.data.source?.kind === 'swarm') {
      userMessages.push({ sessionId: session.header.id, message: structuredClone(event.data) })
    }
    if (event.type === 'tool/call') transcript.push({ sessionId: session.header.id, name: event.data.name, args: event.data.arguments })
    if (event.type === 'tool/call') recentTools.push({ type: event.type, time: event.time, sessionId: session.header.id, name: event.data.name })
    if (event.type === 'tool/result') {
      const failed = toolBlocks([event.data.message]).filter(block => block.isError)
      recentTools.push({ type: event.type, time: event.time, sessionId: session.header.id, error: event.data.error,
        failures: failed.map(block => texts(block).join('\n')) })
    }
    if (recentTools.length > 64) recentTools.splice(0, recentTools.length - 64)
  })
}

const budget = { maxTokens: 50_000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 90_000, maxTasks: 20, maxExperiments: 3 }
const config = {
  statePath: join(runRoot, 'swarm.sqlite'), workspacesRoot: join(runRoot, 'worktrees'),
  // Real Git and child-process checks share the host with integration suites.
  tickMs: 20, leaseMs: 30_000, checkTimeoutMs: 30_000, maxCheckOutputBytes: 16_000,
}

try {
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'value.cjs'), 'module.exports = 1\n')
  await writeFile(join(workspace, 'check.cjs'), "require('node:assert/strict').equal(require('./value.cjs'), 2); console.log('VERIFIED_TWO')\n")
  for (const gitArgs of [
    ['init', '--quiet'], ['config', 'user.name', 'Swarm Smoke'], ['config', 'user.email', 'swarm-smoke@example.invalid'],
    ['add', '.'], ['commit', '--quiet', '-m', 'fixture baseline'],
  ]) await execute('git', gitArgs, { cwd: workspace })
  const baseCommit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim()
  ctx = await bootHarness({ harnessRoot, artifactRoot, runRoot, workspace, swarmConfig: config, bundleProfile })
  attachTranscript(ctx)
  const { SessionId } = await importHarness(harnessRoot, '@deepseek-ai/dsh-session')
  ownerHandle = await ctx.agents.create({
    sessionId: SessionId(ownerId), meta: { cwd: workspace }, agentOptions: { provider: 'swarm-smoke', model: 'swarm-smoke' },
  })
  const mission = (await ownerCall('swarm_create', {
    title: 'Loader composition delivery', objective: 'Produce and independently verify the value two.',
    workspace, scope: ['value.cjs'], acceptance: ['value is two'], budget,
  })).result
  const missionId = mission.id
  const workstream = (await ownerCall('swarm_workstream', { missionId, title: 'Value change', objective: 'Implement and integrate the required value.' })).result
  const builder = (await ownerCall('swarm_add_member', { missionId, name: 'builder', role: 'implementation and integration' })).result
  const reviewer = (await ownerCall('swarm_add_member', { missionId, name: 'reviewer', role: 'independent verifier' })).result
  const implementation = (await ownerCall('swarm_propose', {
    missionId, workstreamId: workstream.id, title: 'Implement value two', objective: 'Change value.cjs to export two.',
    kind: 'implementation', scope: ['value.cjs'], acceptance: ['value is two'], checks: ['node check.cjs'], assigneeId: builder.id,
  })).result
  await waitUntil(() => ctx.swarm.snapshot({ sessionId: ownerId }, missionId).tasks.find(task => task.id === implementation.id)?.status === 'accepted', 'implementation and peer-proposed review')
  const integration = (await ownerCall('swarm_propose', {
    missionId, workstreamId: workstream.id, title: 'Integrate value two', objective: 'Integrate the accepted implementation and validate the deliverable.',
    kind: 'integration', dependencies: [implementation.id], scope: ['value.cjs'], acceptance: ['value is two'], checks: ['node check.cjs'], assigneeId: builder.id,
  })).result
  await waitUntil(() => ctx.swarm.snapshot({ sessionId: ownerId }, missionId).tasks.find(task => task.id === integration.id)?.status === 'accepted', 'integration and independent verification')
  const completion = await ownerCall('swarm_control', { missionId, action: 'complete', reason: 'The accepted integration artifact meets the mission acceptance criterion.' })
  const completed = ctx.swarm.snapshot({ sessionId: ownerId }, missionId)
  assert.equal(completed.mission.status, 'completed')
  assert.equal(completed.tasks.length, 4)
  assert(completed.tasks.every(task => task.status === 'accepted'))
  assert.equal(completed.evidence.length, 2)
  assert(completed.evidence.every(evidence => evidence.status === 'verified'))
  assert(completed.mission.usedSteps > 0 && completed.mission.usedTokens > 0)
  const submitted = completed.tasks.find(task => task.id === integration.id).artifact
  assert.match(submitted.commit, /^[a-f0-9]{40}$/)
  assert.equal((await execute('git', ['show', `${submitted.commit}:value.cjs`], { cwd: workspace })).stdout, 'module.exports = 2\n')
  assert.equal((await execute('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim(), baseCommit)
  assert.equal(await readFile(join(workspace, 'value.cjs'), 'utf8'), 'module.exports = 1\n')
  assert(transcript.some(call => call.sessionId === builder.sessionId && call.name === 'swarm_propose'), 'worker must actually propose its peer’s review')
  assert(transcript.some(call => call.sessionId === builder.sessionId && call.name === 'swarm_message'), 'worker must communicate through the authenticated message tool')
  assert(transcript.some(call => call.sessionId === reviewer.sessionId && call.name === 'swarm_verify'), 'independent peer must actually verify')
  assert(transcript.some(call => call.sessionId === builder.sessionId && call.name === 'bash'), 'worker must run a real Harness tool')
  assert(userMessages.some(delivery => delivery.message.source.deliveryKind === 'assignment'))
  for (const request of requests) {
    for (const message of request.messages.filter(message => message.source?.kind === 'swarm')) {
      assert(userMessages.some(delivery => delivery.sessionId === request.sessionId && delivery.message.id === message.id), 'every model-visible swarm delivery must have a real session-log event')
      assert(texts(message).join('\n').includes(message.source.missionId), 'mission identity must survive provider serialization, which sends content but omits Harness source metadata')
    }
  }
  const assignments = new Map()
  const peerMessages = new Map()
  for (const request of requests) {
    for (const message of request.messages.filter(message => message.source?.kind === 'swarm' && message.source.deliveryKind === 'question')) {
      const rendered = texts(message).join('\n')
      peerMessages.set(message.id, {
        source: { kind: message.source.kind, form: message.source.form, deliveryKind: message.source.deliveryKind },
        content: rendered.slice(rendered.indexOf('\n') + 1),
      })
    }
    for (const message of request.messages.filter(message => message.source?.kind === 'swarm' && message.source.deliveryKind === 'assignment')) {
      if (assignments.has(message.id)) continue
      const rendered = texts(message).join('\n')
      const body = JSON.parse(rendered.slice(rendered.indexOf('\n') + 1))
      assignments.set(message.id, {
        source: { kind: message.source.kind, form: message.source.form, deliveryKind: message.source.deliveryKind },
        task: {
          title: body.task.title, objective: body.task.objective, kind: body.task.kind,
          scope: body.task.scope, acceptance: body.task.acceptance, checks: body.task.checks,
          dependencyCount: body.task.dependencies.length, independentReview: Boolean(body.task.reviewOf),
        },
        instructions: body.instructions,
      })
    }
  }
  const swarmToolNames = request => request.tools.filter(tool => tool.name.startsWith('swarm_')).map(tool => tool.name).sort()
  const ownerRequests = requests.filter(request => request.sessionId === ownerId)
  const workerRequest = requests.find(request => request.sessionId === builder.sessionId)
  const boundarySnapshot = {
    // Before owning a mission the owner sees the entry set; after swarm_create it sees the owner set; workers see only member tools.
    visibleSwarmTools: swarmToolNames(ownerRequests[0]),
    ownerSwarmTools: swarmToolNames(ownerRequests.at(-1)),
    workerSwarmTools: swarmToolNames(workerRequest),
    assignments: [...assignments.values()],
    peerMessages: [...peerMessages.values()],
    completion: completion.result.status,
    acceptedTasks: completed.tasks.map(task => ({ title: task.title, kind: task.kind, status: task.status })).sort((a, b) => a.title.localeCompare(b.title)),
  }
  const snapshotPath = fileURLToPath(new URL('./fixtures/model-visible.expected.json', import.meta.url))
  if (process.env.UPDATE_SMOKE_SNAPSHOT === '1') await writeFile(snapshotPath, JSON.stringify(boundarySnapshot, null, 2) + '\n')
  assert.deepEqual(boundarySnapshot, JSON.parse(await readFile(snapshotPath, 'utf8')), 'the assembled Harness model-visible collaboration snapshot changed')

  // Abort during a live model step, then restore workers without recreating the owner.
  const recoveryMission = (await ownerCall('swarm_create', {
    title: 'Restart recovery', objective: 'Resume the durable task after a host restart.',
    workspace, scope: ['value.cjs'], acceptance: ['value is two'], budget,
  })).result
  const recoveryId = recoveryMission.id
  const recoveryStream = (await ownerCall('swarm_workstream', { missionId: recoveryId, title: 'Recovery work', objective: 'Preserve work across restart.' })).result
  const recoveryBuilder = (await ownerCall('swarm_add_member', { missionId: recoveryId, name: 'recovery-builder', role: 'implementation and integration' })).result
  await ownerCall('swarm_add_member', { missionId: recoveryId, name: 'recovery-reviewer', role: 'independent verifier' })
  workerMode = 'wait'
  const recoveryTask = (await ownerCall('swarm_propose', {
    missionId: recoveryId, workstreamId: recoveryStream.id, title: 'Recover value two', objective: 'Change value.cjs to export two after recovery.',
    kind: 'implementation', scope: ['value.cjs'], acceptance: ['value is two'], checks: ['node check.cjs'], assigneeId: recoveryBuilder.id,
  })).result
  await waitUntil(() => waitingSessions.has(recoveryBuilder.sessionId), 'worker reaches an active real model request')
  const interrupted = ctx.swarm.snapshot({ sessionId: ownerId }, recoveryId).tasks.find(task => task.id === recoveryTask.id)
  assert.equal(interrupted.status, 'running')
  const oldAttempt = interrupted.attempt.id
  await ctx.fiber.dispose()
  ctx = undefined
  ownerHandle = undefined
  workerMode = 'complete'
  ctx = await bootHarness({ harnessRoot, artifactRoot, runRoot, workspace, swarmConfig: config, bundleProfile })
  attachTranscript(ctx)
  assert.equal(ctx.agents.get(SessionId(ownerId)), undefined, 'worker recovery must not require the owner session to be live')
  await waitUntil(() => {
    const state = ctx.swarm.snapshot({ sessionId: ownerId }, recoveryId)
    assert(!state.members.some(member => member.status === 'stopped'), `healthy workers must remain eligible after restart: ${JSON.stringify(state.events.filter(event => event.type === 'member/resume-failed'))}`)
    return state.tasks.find(task => task.id === recoveryTask.id)?.status === 'accepted'
  }, 'owner-independent worker resume and verification')
  const recovered = ctx.swarm.snapshot({ sessionId: ownerId }, recoveryId)
  const restored = recovered.tasks.find(task => task.id === recoveryTask.id)
  assert.notEqual(restored.attempt.id, oldAttempt, 'recovery must fence the old attempt')
  assert(restored.epoch > interrupted.epoch)
  assert(recovered.events.some(event => event.type === 'mission/recovered'))
  assert.equal(ctx.swarm.snapshot({ sessionId: ownerId }, missionId).mission.status, 'completed', 'terminal state must survive restart')
  ownerHandle = await ctx.agents.resume({ resumeSessionId: SessionId(ownerId), agentOptions: { provider: 'swarm-smoke', model: 'swarm-smoke' } })
  await ownerCall('swarm_control', { missionId: recoveryId, action: 'stop', reason: 'Recovery has been demonstrated; retain the reviewed artifact.' })

  const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'swarm' || entry.options.name === '@dsh-external/dsh-agent-swarm')
  assert(entry, 'swarm must be owned by a real Loader entry')
  await entry.update({ disabled: true })
  assert(!ctx.tools.schemas(ownerHandle.agent).some(schema => schema.name.startsWith('swarm_')), 'unload must unregister all swarm tools')
  assert.equal(ctx.agents.list().filter(agent => agent.id !== ownerId).length, 0, 'unload must dispose worker handles')
  process.stdout.write('Real Harness Loader composition passed: model tools, peer proposals, real bash, evidence, independent verification, integration, completion, owner-independent restart recovery, and unload.\n')
} finally {
  if (process.env.DSH_SMOKE_KEEP === '1' && ctx?.get('swarm')) {
    await writeFile(join(temporary, 'diagnostics.json'), JSON.stringify({
      snapshots: ctx.swarm.list(ownerId).map(mission => ctx.swarm.snapshot({ sessionId: ownerId }, mission.id)),
      agents: ctx.agents.list().map(agent => ({ id: agent.id, status: agent.status, pending: agent.inbox.hasPending })),
      scripts: [...scripts],
      requests: requests.map(request => ({
        sessionId: request.sessionId,
        latestMessage: request.messages.at(-1),
        latestAssignment: request.messages.findLast(message => message.source?.kind === 'swarm' && message.source.deliveryKind === 'assignment'),
      })),
    }, null, 2) + '\n')
  }
  await ownerHandle?.dispose()
  await ctx?.fiber.dispose()
  if (process.env.DSH_SMOKE_KEEP === '1') process.stderr.write(`Retained smoke fixtures: ${temporary}\n`)
  else await rm(temporary, { recursive: true, force: true })
}
