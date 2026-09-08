import { resolveHarnessRoot, assertSupportedHarness } from './harness-target.mjs'
/** Billable, real-provider smoke of the native /agent-swarm command and owner-authored plan. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv, promisify } from 'node:util'
import { bootHarness, harnessEntry, importHarness } from '../tests/fixtures/built-harness.mjs'

const execute = promisify(execFile)
const project = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const argument = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const harnessRoot = resolveHarnessRoot(argument('--harness', undefined))
const artifactRoot = resolve(argument('--artifact', project))
const envPath = argument('--env', undefined)
const reportPath = resolve(argument('--report', join(project, 'artifacts/command/deepseek-report.json')))
const model = argument('--model', 'deepseek-v4-flash')
const testTokenCeiling = Number(argument('--test-token-ceiling', '500000'))
const wallSeconds = Number(argument('--deadline-seconds', '360'))
assert(Number.isSafeInteger(testTokenCeiling) && testTokenCeiling >= 25000 && testTokenCeiling <= 500000, '--test-token-ceiling must be an integer from 25000 to 500000')
assert(Number.isSafeInteger(wallSeconds) && wallSeconds >= 60 && wallSeconds <= 600, '--deadline-seconds must be an integer from 60 to 600')

// Read credentials as data. Never execute, rewrite, or copy the user's environment file.
const configured = envPath ? parseEnv(await readFile(resolve(envPath), 'utf8')) : {}
const apiKey = process.env.DEEPSEEK_API_KEY || configured.DEEPSEEK_API_KEY
assert(apiKey, 'DEEPSEEK_API_KEY is absent; export it or use --env with its existing Harness environment file')
const baseURL = process.env.DEEPSEEK_BASE_URL || configured.DEEPSEEK_BASE_URL
const redact = value => String(value).split(apiKey).join('[REDACTED]').replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
const textContent = content => Array.isArray(content) ? content.flatMap(block => block.type === 'text' ? [block.text] : block.content ? [textContent(block.content)] : []).join('\n') : ''
const usageTotal = usage => usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
// Do not serialize arbitrary provider error fields: they may contain request headers.
function errorDetails(error, depth = 0) {
  if (depth >= 5) return { message: '[cause depth limit]' }
  if (error === null || typeof error !== 'object') return { message: redact(error).slice(0, 2000) }
  return {
    name: typeof error.name === 'string' ? redact(error.name) : undefined,
    message: redact(typeof error.message === 'string' ? error.message : String(error)).slice(0, 2000),
    code: ['string', 'number'].includes(typeof error.code) ? redact(error.code) : undefined,
    stack: typeof error.stack === 'string' ? redact(error.stack).slice(0, 6000) : undefined,
    ...(error.cause === undefined ? {} : { cause: errorDetails(error.cause, depth + 1) }),
    ...(Array.isArray(error.errors) ? { errors: error.errors.slice(0, 5).map(item => errorDetails(item, depth + 1)) } : {}),
  }
}

const builtFiles = (await readdir(join(artifactRoot, 'lib'), { recursive: true })).filter(path => path.endsWith('.js')).sort()
const digest = createHash('sha256')
for (const file of builtFiles) { digest.update(file + '\0'); digest.update(await readFile(join(artifactRoot, 'lib', file))) }
const build = {
  pluginVersion: JSON.parse(await readFile(join(artifactRoot, 'package.json'), 'utf8')).version,
  harnessHead: (await execute('git', ['rev-parse', 'HEAD'], { cwd: harnessRoot })).stdout.trim(),
  pluginJavaScriptSHA256: digest.digest('hex'), javaScriptFileCount: builtFiles.length,
}
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'dsh-swarm-command-deepseek-')))
const workspace = join(temporary, 'workspace'), runRoot = join(temporary, 'runtime')
process.env.DEEPSEEK_API_KEY = apiKey
if (baseURL) process.env.DEEPSEEK_BASE_URL = baseURL
process.env.DSH_HOME = join(temporary, 'dsh-home')
process.env.DSH_TELEMETRY_DISABLED = '1'

// These are test termination limits, never product mission defaults. The actual
// owner model supplies all six mission budget fields in its own swarm_launch.
const testLimits = { maxReportedTokens: testTokenCeiling, maxModelSteps: 60, wallSeconds }
const maxOutputTokensPerRequest = 4096
const actor = { sessionId: 'deepseek-command-smoke-owner' }
const goal = [
  'Fix this tiny repository so value.cjs exports 2 and node check.cjs passes.',
  'Inspect the repository first. Change only value.cjs; preserve check.cjs and the original source checkout.',
  'Deliver an integrated artifact with independent verification, and finish the mission automatically.',
  'Keep the plan and responses minimal.',
].join(' ')
const commandLine = `/agent-swarm ${goal}`
const calls = [], toolResults = [], deliveries = [], usage = [], modelErrors = [], lifecycle = [], assistantMessages = []
const activeSteps = new Map()
let ctx, owner, commandExecution, finalSnapshot, finalStarts = [], generatedPlan, failure, baseCommit, disposing = false
let ownerSteps = 0, modelSteps = 0, ownerTokens = 0, totalTokens = 0, testLimit
const started = Date.now()
const checks = {}
const expectedWorkerBudgetStop = item => item.sessionId !== actor.sessionId && /^(?:Mission is (?:blocked|paused)|Mission (?:aggregate|duration) budget exhausted|Mission is inactive or out of budget|Mission is waiting for budget-pause quiescence and a fresh resume assignment)$/.test(item.error)
function stepDiagnostic(sessionId) {
  const step = activeSteps.get(sessionId)
  if (!step) return undefined
  const reason = step.signal.reason
  return {
    turn: step.turn, step: step.step, aborted: step.signal.aborted,
    ...(reason && typeof reason === 'object' ? {
      cancellationKind: typeof reason.kind === 'string' ? redact(reason.kind) : undefined,
      cancellationProperties: Reflect.ownKeys(reason).map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(reason, key)
        return { key: String(key), enumerable: Boolean(descriptor.enumerable), valueType: 'value' in descriptor ? typeof descriptor.value : 'accessor' }
      }),
    } : {}),
  }
}

function captureState() {
  if (!ctx?.get('swarm')) return
  finalStarts = ctx.swarm.starts(actor)
  const missions = ctx.swarm.list(actor.sessionId)
  const missionId = finalStarts[0]?.missionId ?? missions[0]?.id
  if (missionId) finalSnapshot = ctx.swarm.snapshot(actor, missionId)
  if (finalStarts[0]?.draftId) generatedPlan = ctx.swarm.drafts(actor).find(draft => draft.id === finalStarts[0].draftId)?.input
}

try {
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'value.cjs'), 'module.exports = 1\n')
  await writeFile(join(workspace, 'check.cjs'), "require('node:assert/strict').equal(require('./value.cjs'), 2); console.log('VERIFIED_TWO')\n")
  await writeFile(join(workspace, 'README.md'), '# Value fixture\n\nThe value module must export 2. Verify with `node check.cjs`. Keep the check unchanged.\n')
  for (const gitArgs of [
    ['init', '--quiet'], ['config', 'user.name', 'Swarm Command Smoke'], ['config', 'user.email', 'swarm-command@example.invalid'],
    ['add', '.'], ['commit', '--quiet', '-m', 'clean command fixture'],
  ]) await execute('git', gitArgs, { cwd: workspace })
  baseCommit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim()
  ctx = await bootHarness({
    harnessRoot, artifactRoot, runRoot, workspace,
    swarmConfig: {
      statePath: join(runRoot, 'swarm.sqlite'), workspacesRoot: join(runRoot, 'worktrees'),
      tickMs: 100, checkTimeoutMs: 30000, maxCheckOutputBytes: 16000,
    },
    shellConfig: { timeoutMs: 30000 },
    deepseekConfig: {
      apiKeyEnv: 'DEEPSEEK_API_KEY', ...(baseURL ? { baseURL } : {}), thinking: 'disabled', reasoningEffort: 'off',
      maxTokens: maxOutputTokensPerRequest, streamIdleTimeoutMs: 30000, retryPolicy: { mode: 'normal', maxRetries: 0 },
    },
  })
  // The exact built registry is composed by the same Loader, not a command-handler test double.
  await ctx.loader.create({ id: 'native-commands', name: await harnessEntry(harnessRoot, '@deepseek-ai/dsh-commands') })
  await ctx.loader.await()
  assert(ctx.get('commands'), 'Native CommandRuntime must be loaded')
  ctx.on('session/event', (session, event) => {
    const sessionId = session.header.id
    if (event.type === 'tool/call') calls.push({ sessionId, seq: event.seq, name: event.data.name, callId: event.data.callId, arguments: redact(event.data.arguments).slice(0, 16000), atMs: Date.now() - started })
    if (event.type === 'user/message' && ['swarm-start', 'swarm'].includes(event.data.source?.kind)) deliveries.push({
      sessionId, seq: event.seq, source: event.data.source, content: redact(textContent(event.data.content)).slice(0, 16000),
    })
    if (event.type === 'assistant/message') {
      assistantMessages.push({ sessionId, seq: event.seq, text: redact(textContent(event.data.message.content)).slice(0, 16000) })
      if (event.data.usage) {
        usage.push({ sessionId, ...event.data.usage })
        totalTokens += usageTotal(event.data.usage)
        if (sessionId === actor.sessionId) ownerTokens += usageTotal(event.data.usage)
      }
    }
    if (['command/run', 'command/done', 'turn/start', 'turn/end', 'step/start', 'step/end'].includes(event.type)) lifecycle.push({ sessionId, seq: event.seq, type: event.type, data: event.data, phase: disposing ? 'cleanup' : 'execution', atMs: Date.now() - started })
    if (event.type === 'tool/result') for (const block of event.data.message.content.filter(item => item.type === 'tool-result')) {
      const call = calls.find(item => item.sessionId === sessionId && item.callId === block.toolCallId)
      const resultText = redact(textContent(block.content))
      toolResults.push({ sessionId, seq: event.seq, name: call?.name, callId: block.toolCallId, isError: Boolean(block.isError), text: resultText.slice(0, 16000), textCharacters: resultText.length, reportTextTruncated: resultText.length > 16000 })
    }
  })
  ctx.on('agent/error', ({ agent, error }) => modelErrors.push({ sessionId: agent.id, error: redact(error instanceof Error ? error.message : error), details: errorDetails(error), phase: disposing ? 'cleanup' : 'execution', atMs: Date.now() - started, activeStep: stepDiagnostic(agent.id) }))
  ctx.on('agent/pre-step', async ({ agent, signal, turn, step }, next) => {
    // Retained only for read-only diagnostics, never to cancel or authorize later work.
    activeSteps.set(agent.id, { signal, turn, step })
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (modelSteps >= testLimits.maxModelSteps || totalTokens >= testLimits.maxReportedTokens) {
      testLimit = `External smoke termination limit reached: ${modelSteps} model steps and ${totalTokens} reported tokens`
      return { kind: 'reject' }
    }
    modelSteps++
    if (agent.id === actor.sessionId) ownerSteps++
    return decision
  })
  const { SessionId } = await importHarness(harnessRoot, '@deepseek-ai/dsh-session')
  owner = await ctx.agents.create({
    sessionId: SessionId(actor.sessionId), meta: { cwd: workspace },
    agentOptions: { provider: 'deepseek-official', model, maxTokens: maxOutputTokensPerRequest },
  })
  assert(ctx.commands.list(owner.agent).some(command => command.name === 'agent-swarm'), 'The installed plugin must advertise its native /agent-swarm command')
  process.stdout.write(JSON.stringify({ provider: 'deepseek-official', model, credential: 'present', workflow: 'native command -> real owner plan -> real workers -> automatic completion', budgetSource: 'owner-generated plan', testLimits, maxOutputTokensPerRequest }) + '\n')
  const deadline = Date.now() + wallSeconds * 1000
  commandExecution = await ctx.commands.execute(owner.agent, commandLine, [], AbortSignal.timeout(15000))
  assert.equal(commandExecution?.result.kind, 'success', `Native command rejected the request: ${commandExecution?.result.text ?? 'unregistered'}`)
  while (Date.now() < deadline) {
    captureState()
    assert.equal(finalStarts.length, 1, 'One native invocation must create exactly one automatic start')
    assert(ctx.swarm.list(actor.sessionId).length <= 1, 'One invocation must not fan out into multiple missions')
    if (finalStarts[0].status === 'completed' && finalSnapshot?.mission.status === 'completed') break
    if (testLimit) throw new Error(testLimit)
    if (totalTokens >= testLimits.maxReportedTokens) throw new Error('External smoke reported-token ceiling reached')
    const fatalModelError = modelErrors.find(item => !expectedWorkerBudgetStop(item))
    if (fatalModelError) throw new Error(`Real model loop failed: ${fatalModelError.error}`)
    // A rejected generated plan is ordinary tool feedback; allow the same real
    // owner turn to repair it within its existing request and planning budget.
    if (finalStarts[0].status === 'failed' && owner.agent.status === 'idle') throw new Error(`Automatic planning/launch failed: ${finalStarts[0].error}`)
    // The primary can observe exhausted resources, adjust its budget and resume.
    // Let native deliveries and that actual model decision run within the test bound.
    if (finalSnapshot?.mission.status === 'stopped') throw new Error(`Mission was stopped: ${finalSnapshot.mission.reason}`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  captureState()
  assert.equal(finalStarts.length, 1)
  assert.equal(ctx.swarm.list(actor.sessionId).length, 1)
  assert.equal(finalStarts[0].commandId, commandExecution.commandId)
  assert.equal(finalStarts[0].status, 'completed', 'Native command workflow must finish within its wall-clock bound')
  assert.equal(finalSnapshot.mission.status, 'completed', 'Runtime must automatically complete the independently accepted mission')
  checks.singleAutomaticStartAndMission = true
  assert(lifecycle.some(event => event.type === 'command/run' && event.data.name === 'agent-swarm'))
  assert(deliveries.some(delivery => delivery.sessionId === actor.sessionId && delivery.source.kind === 'swarm-start'), 'The owner must receive the durable natural-language start through its real inbox')
  const launch = toolResults.find(result => result.sessionId === actor.sessionId && result.name === 'swarm_launch' && !result.isError)
  assert(launch, 'The actual owner model must successfully invoke swarm_launch with its generated plan')
  assert(toolResults.some(result => result.sessionId === actor.sessionId && result.name === 'bash' && !result.isError && result.seq < launch.seq && /value\.cjs|module\.exports|check\.cjs|Value fixture/.test(result.text)), 'The owner must inspect the fixture through a real tool before launching')
  checks.realOwnerInspectedAndPlanned = true
  assert(generatedPlan?.members.length >= 2 && generatedPlan.tasks.length >= 2)
  for (const name of ['maxTokens', 'maxSteps', 'maxWorkers', 'maxDurationMs', 'maxTasks', 'maxExperiments']) {
    assert(Number.isSafeInteger(generatedPlan.budget[name]), `Actual owner must select budget.${name}`)
  }
  const launchCall = calls.find(call => call.callId === launch.callId && call.sessionId === actor.sessionId)
  const submittedPlan = JSON.parse(launchCall.arguments)
  assert.deepEqual(submittedPlan.budget, generatedPlan.budget, 'Generated budget must come from the actual launch arguments without fixture overrides')
  checks.ownerSelectedBudget = true
  assert(finalSnapshot.members.length >= 2)
  const participatingWorkers = finalSnapshot.members.filter(member => usage.some(entry => entry.sessionId === member.sessionId))
  assert(participatingWorkers.length >= 2, 'At least two independent workers must make actual DeepSeek requests')
  const sources = finalSnapshot.tasks.filter(task => ['implementation', 'integration'].includes(task.kind) && task.status === 'accepted')
  const integration = sources.find(task => task.kind === 'integration' && task.artifact)
  assert(integration, 'A verified integration artifact must be delivered')
  for (const source of sources) {
    const review = finalSnapshot.tasks.find(task => task.kind === 'verification' && task.reviewOf === source.id && task.status === 'accepted')
    assert(review, `Accepted code task ${source.id} must have an accepted independent review`)
    assert.notEqual(review.attempt?.ownerId ?? review.assigneeId, source.attempt?.ownerId ?? source.assigneeId)
    const reviewer = finalSnapshot.members.find(member => member.id === (review.attempt?.ownerId ?? review.assigneeId))
    assert(toolResults.some(result => result.sessionId === reviewer?.sessionId && result.name === 'swarm_verify' && !result.isError), 'The real reviewer must invoke host verification')
  }
  assert(finalSnapshot.evidence.some(evidence => evidence.status === 'verified' && evidence.toolRunIds.length > 0))
  checks.realWorkersAndIndependentEvidence = true
  assert(finalSnapshot.events.some(event => event.type === 'automatic/completed'), 'Completion must come from the automatic runtime path')
  assert(!calls.some(call => call.name === 'swarm_create' || (call.name === 'swarm_control' && JSON.parse(call.arguments).action === 'complete')), 'This smoke must not fall back to direct creation or manual completion; primary budget adjustment and resume remain permitted')
  checks.noManualAdmissionOrCompletion = true
  assert.match(integration.artifact.commit, /^[a-f0-9]{40}$/)
  assert.match((await execute('git', ['show', `${integration.artifact.commit}:value.cjs`], { cwd: workspace })).stdout, /(?:module\.exports\s*=\s*2|exports\s*=\s*2)/)
  assert.equal((await execute('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim(), baseCommit)
  assert.equal((await execute('git', ['status', '--porcelain'], { cwd: workspace })).stdout, '')
  assert.equal(await readFile(join(workspace, 'value.cjs'), 'utf8'), 'module.exports = 1\n')
  checks.immutableDeliverableAndUnchangedSource = true
} catch (error) {
  failure = redact(error instanceof Error ? error.message : error)
  try { captureState() } catch { /* Preserve the original failure when teardown has begun. */ }
} finally {
  // Disposal enforces the wall-clock stop; the harness never authors mission creation or completion.
  disposing = true
  // Node fetch may add a non-enumerable stack to a mutable abort cause. Preserve
  // the native JSON cancellation intent before handle disposal wins its first cause.
  try { owner?.agent.cancel(Object.freeze({ kind: 'disposed' })) } catch (error) { failure ??= `Owner cancellation failed: ${redact(error)}` }
  try { await owner?.dispose() } catch (error) { failure ??= `Owner disposal failed: ${redact(error)}` }
  try { await ctx?.fiber.dispose() } catch (error) { failure ??= `Harness disposal failed: ${redact(error)}` }
  const totals = rows => rows.reduce((total, item) => ({ input: total.input + item.inputTokens, output: total.output + item.outputTokens, cacheRead: total.cacheRead + (item.cacheReadTokens ?? 0), cacheWrite: total.cacheWrite + (item.cacheWriteTokens ?? 0) }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  let endpoint = 'https://api.deepseek.com'
  try { if (baseURL) endpoint = new URL(baseURL).origin } catch { endpoint = 'configured endpoint' }
  const report = {
    passed: !failure, ...(failure ? { failure } : {}), workflow: 'native /agent-swarm command with real owner-generated plan and automatic completion',
    provider: 'deepseek-official', model, credentialPresent: true, endpoint, build, elapsedMs: Date.now() - started,
    command: { text: commandLine, id: commandExecution?.commandId, result: commandExecution?.result },
    hostControlled: ['isolated clean fixture', 'native command invocation', 'bounded test termination'],
    actualModels: 'owner planner and independent workers; no scripted adapter', budgetSource: 'owner-generated plan', initialBudget: generatedPlan?.budget, finalBudget: finalSnapshot?.mission.budget, testLimits, ownerSteps, modelSteps, maxOutputTokensPerRequest,
    budgetAdjustments: calls.filter(call => call.name === 'swarm_budget').map(call => ({ ...call, result: toolResults.find(result => result.sessionId === call.sessionId && result.callId === call.callId) })),
    testLimitNote: 'External test-only admission/termination guard; does not replace the model-selected mission budget. Concurrent in-flight requests may finish after a reported-token threshold.',
    costUSD: null, costNote: 'Provider-reported usage only; no billed dollar total is asserted.',
    checks, starts: finalStarts, generatedPlan, mission: finalSnapshot?.mission,
    members: finalSnapshot?.members.map(member => ({ id: member.id, name: member.name, role: member.role, sessionId: member.sessionId, status: member.status, model: member.model, provider: member.provider })),
    tasks: finalSnapshot?.tasks.map(task => ({ id: task.id, kind: task.kind, status: task.status, artifact: task.artifact?.commit, reviewOf: task.reviewOf, assigneeId: task.assigneeId })),
    evidence: finalSnapshot?.evidence.map(evidence => ({ status: evidence.status, taskId: evidence.taskId, toolRunCount: evidence.toolRunIds.length })),
    tokenTotals: { all: totals(usage), owner: totals(usage.filter(item => item.sessionId === actor.sessionId)), workers: totals(usage.filter(item => item.sessionId !== actor.sessionId)), workerRuntimeAccounted: finalSnapshot?.mission.usedTokens },
    usage, calls, toolResults, deliveries, lifecycle, modelErrors, assistantMessages,
    expectedWorkerBudgetStops: modelErrors.filter(expectedWorkerBudgetStop),
  }
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, redact(JSON.stringify(report, null, 2)) + '\n')
  if (process.env.DSH_SMOKE_KEEP === '1') process.stderr.write(`Retained temporary command smoke: ${temporary}\n`)
  else await rm(temporary, { recursive: true, force: true })
  process.stdout.write(JSON.stringify({ passed: !failure, ...(failure ? { failure } : {}), reportPath, ownerTokens, workerTokens: finalSnapshot?.mission.usedTokens, modelResponses: usage.length }) + '\n')
}
if (failure) process.exitCode = 1
