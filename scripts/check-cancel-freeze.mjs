import { resolveHarnessRoot, assertSupportedHarness } from './harness-target.mjs'
/** Unpaid loopback HTTP diagnostic: frozen native cancellation stays valid session JSON. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootHarness, importHarness } from '../tests/fixtures/built-harness.mjs'

const project = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const argument = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const harnessRoot = resolveHarnessRoot(argument('--harness', undefined))
const reportPath = resolve(argument('--report', join(project, 'artifacts/command/cancel-freeze-diagnostic.json')))
const { isJsonValue, SessionId } = await importHarness(harnessRoot, '@deepseek-ai/dsh-session')
const { createUserMessage } = await importHarness(harnessRoot, '@deepseek-ai/dsh-llm')
const root = await realpath(await mkdtemp(join(tmpdir(), 'swarm-freeze-cancel-')))
const workspace = join(root, 'workspace')
await mkdir(workspace)
process.env.DSH_HOME = join(root, 'dsh-home')
process.env.DSH_TELEMETRY_DISABLED = '1'
// This fake credential is sent exclusively to this process's loopback server.
// The diagnostic neither reads the user's key nor calls an external provider.
process.env.DSH_SWARM_FREEZE_FIXTURE_KEY = 'local-unpaid-fixture'
let arrived, requests = 0, ctx
const server = createServer(req => { requests++; req.resume(); arrived?.resolve() })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const baseURL = `http://127.0.0.1:${server.address().port}`
const results = [], errors = []
async function waitForRequest() {
  let timer
  try {
    await Promise.race([arrived.promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Loopback request did not arrive within 5 seconds')), 5000)
    })])
  } finally { clearTimeout(timer) }
}

try {
  const controller = new AbortController(), cause = Object.freeze({ kind: 'parent' })
  arrived = Promise.withResolvers()
  const pending = fetch(baseURL, { signal: controller.signal })
  await waitForRequest()
  controller.abort(cause)
  let rejectedType
  try { await pending } catch (error) { rejectedType = error?.name ?? typeof error }
  assert(isJsonValue({ turn: 1, reason: { kind: 'aborted', reason: controller.signal.reason } }))
  results.push({ kind: 'plain-fetch', rejectedType, causeKeys: Reflect.ownKeys(cause), causeStillJson: isJsonValue(cause) })
  ctx = await bootHarness({
    harnessRoot, artifactRoot: project, runRoot: join(root, 'runtime'), workspace,
    swarmConfig: { statePath: join(root, 'swarm.sqlite'), workspacesRoot: join(root, 'worktrees') },
    deepseekConfig: {
      apiKeyEnv: 'DSH_SWARM_FREEZE_FIXTURE_KEY', baseURL, thinking: 'disabled', reasoningEffort: 'off',
      maxTokens: 64, streamIdleTimeoutMs: 10000, retryPolicy: { mode: 'normal', maxRetries: 0 },
    },
  })
  ctx.on('agent/error', ({ agent, error }) => errors.push({ sessionId: agent.id, message: String(error) }))
  for (const kind of ['parent', 'disposed']) {
    const handle = await ctx.agents.create({
      sessionId: SessionId(`freeze-${kind}`), meta: { cwd: workspace },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 64 },
    })
    arrived = Promise.withResolvers()
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Wait for a response.' }] }))
    await waitForRequest()
    handle.agent.cancel(Object.freeze({ kind }))
    await handle.dispose()
    const ended = handle.agent.session.snapshotEvents().filter(event => event.type === 'turn/end')
    assert.equal(ended.length, 1)
    assert.equal(ended[0].data.reason.kind, 'aborted')
    assert.equal(ended[0].data.reason.reason.kind, kind)
    assert(isJsonValue(ended[0].data))
    results.push({ kind: `native-${kind}-then-dispose`, turnEnd: ended[0].data, validNativeJson: true })
  }
  assert.deepEqual(errors, [])
  const report = { passed: true, providerPaidRequests: 0, localHttpRequests: requests, node: process.version, results, errors }
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(JSON.stringify(report) + '\n')
} finally {
  await ctx?.fiber.dispose()
  server.closeAllConnections()
  server.close()
  await rm(root, { recursive: true, force: true })
}
