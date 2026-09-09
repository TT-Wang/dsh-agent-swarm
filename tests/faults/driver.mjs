/**
 * Child-process driver for the crash scenarios (F4, F8).
 *
 * A crash can only be proven by a process that actually dies mid-operation and
 * a second process that recovers from the same durable store. The driver owns
 * one phase per invocation and never asserts; the parent scenario asserts.
 *
 *   node tests/faults/driver.mjs <phase> --state <dir> --workspace <dir> --worktrees <dir>
 *     --mission <id> [--task <id>] [--marker <file>]
 *
 * Phases: f4-crash, f4-recover, f8-crash, f8-replay.
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SwarmRuntime, Workspaces, WorkspaceWorkers, PROJECT, events, eventually, setup, acceptThroughReview } from './harness.mjs'

const { applyDelivery: realApplyDelivery } = await import(pathToFileURL(join(PROJECT, 'lib/delivery.js')).href)

const args = process.argv.slice(2)
const phase = args[0]
const value = name => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1] }
const stateDir = value('--state')
const workspace = value('--workspace')
const workspacesRoot = value('--worktrees')
const missionId = value('--mission')
const taskId = value('--task')
const marker = value('--marker')
assert(phase && stateDir && workspacesRoot, 'driver requires a phase, --state and --worktrees')

const workspaces = new Workspaces({ workspacesRoot, checkTimeoutMs: 30_000, maxCheckOutputBytes: 32_000, confineCheck: argv => argv })

class DriverWorkers extends WorkspaceWorkers {
  async prepareBaseline(mission, signal) { return await this.workspaces.prepareBaseline(mission, signal) }
  async applyDelivery(mission, resultCommit, signal) {
    // The real delivery engine materializes the delta; the crash then lands
    // after the effect but before the runtime commits its receipt.
    const result = await realApplyDelivery({ source: mission.workspace, baselineCommit: mission.baseline.snapshotCommit, resultCommit }, signal)
    if (marker) await writeFile(marker, JSON.stringify({ phase, result, at: Date.now() }))
    if (phase === 'f8-crash') process.kill(process.pid, 'SIGKILL')
    return result
  }
}

await mkdir(stateDir, { recursive: true })
const config = {
  statePath: join(stateDir, 'swarm.sqlite'), leaseMs: 600_000, tickMs: 20, maxMessageChars: 16_000,
  maxEvents: 5_000, maxTasksPerMember: 3, checkTimeoutMs: 30_000,
}

if (phase === 'f4-crash') {
  // The crashed process must own the running integration attempt, so the whole
  // setup happens here and the process dies without disposing the runtime.
  const workers = new DriverWorkers(workspaces)
  const f = await setup({ workspace, workers, config })
  const first = f.propose({ title: 'Implementation one' })
  const second = f.propose({ title: 'Implementation two' })
  await acceptThroughReview(f, first)
  await acceptThroughReview(f, second)
  const integration = f.runtime.propose(f.owner, f.mission.id, {
    workstreamId: f.stream.id, title: 'Integrate both implementations', objective: 'Assemble the deliverable',
    kind: 'integration', dependencies: [first.id, second.id], scope: ['**'], acceptance: ['fault recovery is proven from durable state'],
    checks: ['true'], assigneeId: f.author.id,
  })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, integration.id)
  assert.equal(claimed.status, 'running', 'the crashed host owns a running integration attempt')
  const member = f.runtime.store.get('members', f.author.id)
  const partial = 'partial integration work\n'
  await writeFile(join(member.workspace, 'src', 'answer.txt'), partial)
  if (marker) await writeFile(marker, JSON.stringify({
    phase, missionId: f.mission.id, taskId: integration.id, attemptId: claimed.attempt.id, epoch: claimed.epoch, partial, at: Date.now(),
  }))
  process.kill(process.pid, 'SIGKILL')
}

const workers = new DriverWorkers(workspaces)
const runtime = new SwarmRuntime(config, workers)
await runtime.start()
const owner = { sessionId: 'fault-owner' }

if (phase === 'f4-recover') {
  await eventually(() => events(runtime, missionId, 'mission/recovered').length > 0, 'the restarted host recovers the mission', 15_000)
  const task = runtime.store.get('tasks', taskId)
  const member = runtime.store.list('members', missionId).find(item => item.id === task.plannedAssigneeId) ?? runtime.store.list('members', missionId)[0]
  const partial = member ? await readFile(join(member.workspace, 'src', 'answer.txt'), 'utf8').catch(() => null) : null
  process.stdout.write(`${JSON.stringify({
    phase, recoveredEvents: events(runtime, missionId, 'mission/recovered').length, status: task.status,
    epoch: task.epoch, artifact: task.artifact ?? null, attempt: task.attempt?.id ?? null, partial,
    appliedDelivery: runtime.snapshot(owner, missionId).mission.appliedDelivery ?? null,
  })}\n`)
}

if (phase === 'f8-crash' || phase === 'f8-replay') {
  const result = await runtime.applyDelivery(owner, missionId)
  const mission = runtime.snapshot(owner, missionId).mission
  process.stdout.write(`${JSON.stringify({
    phase, status: result.status, changedPaths: result.changedPaths,
    appliedDelivery: mission.appliedDelivery ?? null, appliedEvents: events(runtime, missionId, 'delivery/applied').length,
  })}\n`)
}

await runtime.dispose()
await workspaces.dispose()
