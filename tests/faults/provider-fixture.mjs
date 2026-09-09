/**
 * Shared fixture and runner for the provider-fault tier (F3a/F3b/F3c).
 *
 * A real Loader composition, a real git workspace, a real owner session (worker
 * creation needs the owner composition) and a real worker agent driven by the
 * scripted fault provider. The fault is installed before the assignment can
 * reach the provider, and every scenario proves the fault fired before it
 * asserts recovery.
 */
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { bootFaultHarness, importHarness, resolveHarnessRoot, FAULT_OWNER } from './loader.mjs'
import { makeRepo, eventually, events, budget as defaultBudget, runScenario } from './harness.mjs'
import { requests, faults, setScript } from './scripted-provider.mjs'

export async function providerFixture({ leaseMs = 60_000, fault }) {
  const { root, source } = await makeRepo('swarm-faults-provider', { 'src/answer.txt': 'base\n' })
  const runRoot = join(root, 'runtime')
  await mkdir(runRoot, { recursive: true })
  const state = { authorSessionId: undefined, taskId: undefined }
  // Installed before the task exists, so the first worker request cannot race it.
  setScript(options => {
    if (options.sessionId !== state.authorSessionId) return { kind: 'text', text: 'Owner turn complete.' }
    const count = requests.filter(request => request.sessionId === state.authorSessionId).length
    if (count === 1) return fault(state)
    return { kind: 'wait' }
  })
  const ctx = await bootFaultHarness({
    runRoot, workspace: source,
    swarmConfig: {
      statePath: join(runRoot, 'swarm.sqlite'), workspacesRoot: join(runRoot, 'worktrees'),
      tickMs: 20, leaseMs, checkTimeoutMs: 30_000, maxCheckOutputBytes: 16_000,
    },
  })
  const { SessionId } = await importHarness(resolveHarnessRoot(), '@deepseek-ai/dsh-session')
  const ownerHandle = await ctx.agents.create({
    sessionId: SessionId(FAULT_OWNER.sessionId), meta: { cwd: source },
    agentOptions: { provider: 'swarm-smoke', model: 'swarm-smoke' },
  })
  const runtime = ctx.swarm
  const mission = runtime.create(FAULT_OWNER, {
    title: 'Provider fault injection', objective: 'Prove the provider fault fired and recovery is per mode',
    workspace: source, scope: ['**'], acceptance: ['provider fault recovery holds'], budget: defaultBudget,
  })
  const stream = runtime.workstream(FAULT_OWNER, mission.id, { title: 'Provider faults', objective: 'Exercise the provider boundary' })
  const author = await runtime.addMember(FAULT_OWNER, mission.id, { name: 'Author', role: 'implementation', maxOutputTokens: 5_000 })
  state.authorSessionId = author.sessionId
  // Registered before the task is proposed, so no worker tool event can be missed.
  const sessionEvents = []
  const stop = ctx.on('session/event', (session, event) => {
    if (session.header.id !== author.sessionId) return
    if (event.type === 'tool/call') sessionEvents.push({ type: 'call', name: event.data.name, arguments: event.data.arguments })
    if (event.type === 'tool/result') {
      const results = (event.data.message?.content ?? []).filter(block => block.type === 'tool-result')
      sessionEvents.push({
        type: 'result', isError: results.some(block => block.isError),
        text: results.flatMap(block => (block.content ?? []).filter(part => part.type === 'text').map(part => part.text)).join('\n'),
      })
    }
  })
  const task = runtime.propose(FAULT_OWNER, mission.id, {
    workstreamId: stream.id, title: 'Provider fault target', objective: 'Carry the injected provider fault',
    kind: 'implementation', scope: ['**'], acceptance: ['provider fault recovery holds'], checks: ['true'], assigneeId: author.id,
  })
  state.taskId = task.id
  const claimed = await eventually(() => {
    const current = runtime.store.get('tasks', task.id)
    return current.status === 'running' && current.attempt ? current : undefined
  }, 'the worker agent is assigned the task', 15_000)
  const workerRequests = () => requests.filter(request => request.sessionId === author.sessionId).length
  const cleanup = async () => {
    stop?.()
    await ownerHandle.dispose()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
  return { root, source, ctx, runtime, mission, stream, author, task, claimed, sessionEvents, workerRequests, cleanup }
}

/** Common assertions: fault fired, attempt survived, worker retried, nothing published. */
export async function runProviderFault({ id, title, mode, fault, assertFault }) {
  await runScenario({
    id, title, invariants: ['I3', 'I12'],
    body: async () => {
      const fixture = await providerFixture({ fault })
      try {
        await eventually(() => faults.fired >= 1, 'the injected provider fault fires', 15_000)
        assert.deepEqual(faults.modes, [mode], 'the expected fault mode fired exactly once')
        const afterFault = fixture.runtime.store.get('tasks', fixture.task.id)
        assert.equal(afterFault.epoch, fixture.claimed.epoch, 'I3: the provider fault spends no new epoch')
        assert.equal(afterFault.attempt?.id, fixture.claimed.attempt.id, 'I3: the attempt survives the provider fault')
        assert.equal(afterFault.recoveryCount ?? 0, fixture.claimed.recoveryCount ?? 0, 'I3: recoveryCount is unchanged')
        assert.equal(afterFault.artifact, undefined, 'I3: no partial artifact is trusted')
        await assertFault(fixture)
        // The worker retries inside the same attempt rather than starting a new one.
        await eventually(() => {
          const current = fixture.runtime.store.get('tasks', fixture.task.id)
          return fixture.workerRequests() >= 2 && current.attempt?.id === fixture.claimed.attempt.id ? current : undefined
        }, 'the worker retries inside the same attempt', 15_000)
        const afterRetry = fixture.runtime.store.get('tasks', fixture.task.id)
        assert.equal(afterRetry.epoch, fixture.claimed.epoch, 'I3: the retry keeps the same epoch')
        assert.equal(afterRetry.recoveryCount ?? 0, fixture.claimed.recoveryCount ?? 0, 'I3: the retry spends no recovery credit')
        assert.equal(afterRetry.artifact, undefined, 'I3: the retry publishes no artifact')
        assert.equal(events(fixture.runtime, fixture.mission.id, 'task/submitted').length, 0, 'I3: no submission is recorded')
        return { mode, fired: faults.fired, workerRequests: fixture.workerRequests(), epoch: afterRetry.epoch, attempt: afterRetry.attempt.id }
      } finally { await fixture.cleanup() }
    },
  })
}
