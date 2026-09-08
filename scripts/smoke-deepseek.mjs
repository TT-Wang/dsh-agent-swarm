import { resolveHarnessRoot, assertSupportedHarness } from './harness-target.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv, promisify } from 'node:util'
import { bootHarness, importHarness } from '../tests/fixtures/built-harness.mjs'

const execute = promisify(execFile)
const project = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const argument = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const harnessRoot = resolveHarnessRoot(argument('--harness', undefined))
const artifactRoot = resolve(argument('--artifact', project))
const envPath = argument('--env', undefined)
const reportPath = resolve(argument('--report', join(project, 'artifacts/deepseek-smoke.json')))
// Parse data, never source shell code; import only the two provider connection fields.
const configured = envPath ? parseEnv(await readFile(resolve(envPath), 'utf8')) : {}
const apiKey = process.env.DEEPSEEK_API_KEY || configured.DEEPSEEK_API_KEY
assert(apiKey, 'DEEPSEEK_API_KEY is absent; export it or use --env with its existing Harness environment file')
const baseURL = process.env.DEEPSEEK_BASE_URL || configured.DEEPSEEK_BASE_URL
const model = argument('--model', 'deepseek-v4-flash')
const messageEarly = args.includes('--message-early')
const builtFiles = (await readdir(join(artifactRoot, 'lib'), { recursive: true })).filter(path => path.endsWith('.js')).sort()
const buildHash = createHash('sha256')
for (const file of builtFiles) { buildHash.update(file + '\0'); buildHash.update(await readFile(join(artifactRoot, 'lib', file))) }
const build = {
  pluginVersion: JSON.parse(await readFile(join(artifactRoot, 'package.json'), 'utf8')).version,
  harnessHead: (await execute('git', ['rev-parse', 'HEAD'], { cwd: harnessRoot })).stdout.trim(),
  pluginJavaScriptSHA256: buildHash.digest('hex'), javaScriptFileCount: builtFiles.length,
}
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'dsh-swarm-deepseek-')))
const workspace = join(temporary, 'workspace')
const runRoot = join(temporary, 'runtime')
process.env.DEEPSEEK_API_KEY = apiKey
if (baseURL) process.env.DEEPSEEK_BASE_URL = baseURL
// Anonymous provider identity, shell environment, state, and sessions stay in this temporary home.
process.env.DSH_HOME = join(temporary, 'dsh-home')
process.env.DSH_TELEMETRY_DISABLED = '1'
const tokenBudget = Number(argument('--budget-tokens', '150000'))
assert(Number.isSafeInteger(tokenBudget) && tokenBudget > 0 && tokenBudget <= 1_000_000, '--budget-tokens must be an integer from 1 to 1000000')
const budget = { maxTokens: tokenBudget, maxSteps: 24, maxWorkers: 2, maxDurationMs: 180_000, maxTasks: 4, maxExperiments: 1 }
const actor = { sessionId: 'deepseek-smoke-owner' }
const calls = []
const toolResults = []
const deliveries = []
const usage = []
const modelErrors = []
const toolErrors = []
const redact = value => String(value).split(apiKey).join('[REDACTED]').replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
const started = Date.now()
let ctx
let owner
let missionId
let failure
let finalSnapshot
let baseCommit

try {
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'value.cjs'), 'module.exports = 1\n')
  await writeFile(join(workspace, 'check.cjs'), "require('node:assert/strict').equal(require('./value.cjs'), 2); console.log('VERIFIED_TWO')\n")
  for (const gitArgs of [
    ['init', '--quiet'], ['config', 'user.name', 'Swarm Live Smoke'], ['config', 'user.email', 'swarm-smoke@example.invalid'],
    ['add', '.'], ['commit', '--quiet', '-m', 'fixture baseline'],
  ]) await execute('git', gitArgs, { cwd: workspace })
  baseCommit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim()
  ctx = await bootHarness({
    harnessRoot, artifactRoot, runRoot, workspace,
    swarmConfig: {
      statePath: join(runRoot, 'swarm.sqlite'), workspacesRoot: join(runRoot, 'worktrees'),
      tickMs: 100, leaseMs: 120_000, checkTimeoutMs: 5000, maxCheckOutputBytes: 16_000, maxAttempts: 2,
    },
    deepseekConfig: {
      apiKeyEnv: 'DEEPSEEK_API_KEY', ...(baseURL ? { baseURL } : {}), thinking: 'disabled', reasoningEffort: 'off',
      maxTokens: 1024, streamIdleTimeoutMs: 30_000, retryPolicy: { mode: 'normal', maxRetries: 0 },
    },
  })
  ctx.on('session/event', (session, event) => {
    const sessionId = session.header.id
    if (event.type === 'tool/call') calls.push({ sessionId, name: event.data.name, callId: event.data.callId })
    if (event.type === 'user/message' && event.data.source?.kind === 'swarm') deliveries.push({
      sessionId, kind: event.data.source.deliveryKind,
      content: redact(event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')),
    })
    if (event.type === 'assistant/message' && event.data.usage) usage.push({ sessionId, ...event.data.usage })
    if (event.type === 'tool/result') {
      for (const block of event.data.message.content.filter(block => block.type === 'tool-result')) {
        const call = calls.find(call => call.sessionId === sessionId && call.callId === block.toolCallId)
        toolResults.push({ sessionId, name: call?.name, callId: block.toolCallId, isError: Boolean(block.isError) })
        if (block.isError) toolErrors.push({ sessionId, name: call?.name, detail: redact(JSON.stringify(block)).slice(0, 1200) })
      }
    }
    if (event.type.includes('error') || event.type.includes('failed')) modelErrors.push({ sessionId, type: event.type, detail: redact(JSON.stringify(event.data)).slice(0, 800) })
  })
  const { SessionId } = await importHarness(harnessRoot, '@deepseek-ai/dsh-session')
  owner = await ctx.agents.create({
    sessionId: SessionId(actor.sessionId), meta: { cwd: workspace },
    agentOptions: { provider: 'deepseek-official', model, maxTokens: 1024 },
  })
  const mission = ctx.swarm.create(actor, {
    title: 'Actual DeepSeek collaboration smoke', objective: 'Deliver an independently verified change making value.cjs export two.',
    workspace, scope: ['value.cjs'], acceptance: ['value.cjs exports 2 and node check.cjs passes'], budget,
  })
  missionId = mission.id
  const stream = ctx.swarm.workstream(actor, missionId, { title: 'Value change', objective: 'Make and independently review the small delivery.' })
  const builder = await ctx.swarm.addMember(actor, missionId, {
    name: 'builder', role: 'implementer and integrator; carry out assigned work using bash and host-recorded evidence, then request independent review and submit',
  })
  const reviewer = await ctx.swarm.addMember(actor, missionId, {
    name: 'reviewer', role: 'independent verifier; on an assigned verification task, observe its current attempt then call swarm_verify with the appropriate verdict; swarm_verify itself materializes and runs required checks against the exact submitted commit, so use that tool directly rather than reimplementing it with bash; do not submit verification tasks. Without a running assigned review, call swarm_wait to park until an assignment arrives; do not poll or run bash',
  })
  // The host controls only admission and final completion. Both workers use the real provider.
  // Disposing this seed owner also demonstrates workers operate without a live coordinator session.
  await owner.dispose()
  owner = undefined
  const task = ctx.swarm.propose(actor, missionId, {
    workstreamId: stream.id, title: 'Deliver value two', kind: 'integration', assigneeId: builder.id,
    scope: ['value.cjs'], acceptance: ['value.cjs exports 2 and node check.cjs passes'], checks: ['node check.cjs'],
    objective: [
      'Change value.cjs to export 2, preserving check.cjs. Work only in your assigned directory. Be concise.',
      'Your assignment message carries your task and attempt IDs; swarm_observe returns the same focused view. Use bash to inspect/change value.cjs and run node check.cjs.',
      'Each bash result ends with its host toolRunId; publish supported evidence with swarm_publish citing the successful bash run.',
      ...(messageEarly ? [`Before proposing review, send reviewer ${reviewer.id} one short swarm_message question requesting independent review; tell them to swarm_wait if their assigned verification task has not arrived yet.`] : []),
      `Propose one verification task in this same workstream, reviewOf your current task ID, assigneeId ${reviewer.id}, same scope/acceptance, and no dependencies. Its objective is: observe current assigned review attempt then call swarm_verify; do not swarm_submit a verification task.`,
      `Then swarm_submit your own current task and attempt with a short output.${messageEarly ? ' End your turn.' : ` After submitting, send reviewer ${reviewer.id} one short swarm_message question requesting independent review, then end your turn.`}`,
      'Do not call swarm_verify on your own work. Do not create more tasks or wait loops.',
    ].join('\n'),
  })
  process.stdout.write(JSON.stringify({ provider: 'deepseek-official', model, credential: 'present', budget, outputTokensPerRequest: 1024 }) + '\n')
  const deadline = Date.now() + budget.maxDurationMs
  while (Date.now() < deadline) {
    const snapshot = ctx.swarm.snapshot(actor, missionId)
    const current = snapshot.tasks.find(candidate => candidate.id === task.id)
    if (current.status === 'accepted') break
    if (snapshot.mission.status !== 'active') throw new Error(`Mission became ${snapshot.mission.status}: ${snapshot.mission.reason}`)
    if (current.status === 'blocked' || current.status === 'cancelled') throw new Error(`Delivery task became ${current.status}`)
    if (modelErrors.length) throw new Error(`Harness model loop reported ${modelErrors[0].type}: ${modelErrors[0].detail}`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  const accepted = ctx.swarm.snapshot(actor, missionId)
  assert.equal(accepted.tasks.find(candidate => candidate.id === task.id).status, 'accepted', 'real workers must finish and independently verify within the bounded time')
  assert(calls.some(call => call.sessionId === builder.sessionId && call.name === 'swarm_propose'), 'the actual builder model must propose peer review')
  assert(calls.some(call => call.sessionId === builder.sessionId && call.name === 'swarm_message'), 'the actual builder model must send its peer a message')
  assert(calls.some(call => call.sessionId === reviewer.sessionId && call.name === 'swarm_verify'), 'the actual reviewer model must invoke independent host verification')
  assert(accepted.evidence.some(evidence => evidence.status === 'verified' && evidence.toolRunIds.length > 0))
  const artifact = accepted.tasks.find(candidate => candidate.id === task.id).artifact
  assert.match(artifact.commit, /^[a-f0-9]{40}$/)
  assert.match((await execute('git', ['show', `${artifact.commit}:value.cjs`], { cwd: workspace })).stdout, /(?:module\.exports\s*=\s*2|exports\s*=\s*2)/)
  assert.equal((await execute('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim(), baseCommit)
  assert.equal(await readFile(join(workspace, 'value.cjs'), 'utf8'), 'module.exports = 1\n')
  ctx.swarm.control(actor, missionId, 'complete', 'The real DeepSeek workers delivered and independently verified the bounded fixture artifact.')
  finalSnapshot = ctx.swarm.snapshot(actor, missionId)
} catch (error) {
  failure = redact(error instanceof Error ? error.message : error)
  if (missionId && ctx?.get('swarm')) finalSnapshot = ctx.swarm.snapshot(actor, missionId)
} finally {
  if (missionId && ctx?.get('swarm') && ctx.swarm.snapshot(actor, missionId).mission.status === 'active') {
    ctx.swarm.control(actor, missionId, 'stop', 'The bounded live smoke has ended.')
  }
  await owner?.dispose()
  await ctx?.fiber.dispose()
  const report = {
    passed: !failure, ...(failure ? { failure } : {}), provider: 'deepseek-official', model,
    credentialPresent: true, endpoint: baseURL ? new URL(baseURL).origin : 'https://api.deepseek.com', build, messageEarly,
    elapsedMs: Date.now() - started, hostControlled: ['mission admission', 'membership', 'initial task', 'completion'],
    actualModels: 'builder and independent reviewer; no scripted adapter', budget, maxOutputTokensPerRequest: 1024,
    costUSD: null, costNote: 'Provider-reported token usage below; no billing total returned, so no dollar cost is asserted.',
    mission: finalSnapshot?.mission, tasks: finalSnapshot?.tasks.map(task => ({ id: task.id, kind: task.kind, status: task.status, artifact: task.artifact?.commit, reviewOf: task.reviewOf })),
    evidence: finalSnapshot?.evidence.map(evidence => ({ status: evidence.status, toolRunCount: evidence.toolRunIds.length })),
    parkingToolObserved: calls.some(call => call.name === 'swarm_wait'),
    parkingToolSucceeded: toolResults.some(result => result.name === 'swarm_wait' && !result.isError),
    tokenTotals: usage.reduce((total, item) => ({
      uncachedInput: total.uncachedInput + item.inputTokens, output: total.output + item.outputTokens,
      cacheRead: total.cacheRead + (item.cacheReadTokens ?? 0), cacheWrite: total.cacheWrite + (item.cacheWriteTokens ?? 0),
    }), { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    usage, calls, toolResults, deliveries, modelErrors, toolErrors,
  }
  await mkdir(resolve(reportPath, '..'), { recursive: true })
  await writeFile(reportPath, redact(JSON.stringify(report, null, 2)) + '\n')
  if (process.env.DSH_SMOKE_KEEP === '1') process.stderr.write(`Retained temporary live smoke: ${temporary}\n`)
  else await rm(temporary, { recursive: true, force: true })
  process.stdout.write(JSON.stringify({ passed: !failure, ...(failure ? { failure } : {}), reportPath, tokens: finalSnapshot?.mission.usedTokens, steps: finalSnapshot?.mission.usedSteps, modelResponses: usage.length }) + '\n')
}
if (failure) process.exitCode = 1
