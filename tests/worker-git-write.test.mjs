/** W7 regressions: a denied worker git write is typed, actionable and never blocks submission. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 3, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 }
async function eventually(read, message) {
  const deadline = Date.now() + 2500
  while (Date.now() < deadline) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail(message)
}

class GitWorkers {
  prepared = []; stopped = []; deliveries = []
  checks = [{ command: 'test', exitCode: 0, output: 'ok' }]
  artifact = { commit: 'e'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: ['src/a.ts'] }
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async start() {}
  async deliver(member, delivery) { this.deliveries.push({ memberId: member.id, delivery }) }
  async stop(memberId) { this.stopped.push(memberId) }
  isIdle() { return false }
  async prepareTask(member, task) { this.prepared.push(structuredClone({ member: member.id, task })) }
  async captureArtifact() { return this.artifact }
  async verifyArtifact() { return this.checks }
  async dispose() {}
}

const deniedCommit = {
  tool: 'bash',
  arguments: { command: 'git commit -m "integrate branches"' },
  result: { isError: true, content: [{ type: 'text', text: "fatal: Unable to create '/repo/.git/worktrees/author/index.lock': Operation not permitted" }] },
  isError: true,
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-gitwrite-'))
  const workers = new GitWorkers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 60000,
    maxMessageChars: 10000, maxEvents: 300, maxTasksPerMember: 100 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'git-owner' }
  const mission = runtime.create(owner, { title: 'Git write', objective: 'Surface the sandbox boundary', workspace: directory,
    scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  const actor = member => ({ sessionId: member.sessionId })
  const propose = (extra = {}) => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Implement', objective: 'Implement',
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], ...extra })
  const events = type => runtime.store.events(mission.id, 500).filter(event => event.type === type)
  return { runtime, workers, owner, mission, author, reviewer, actor, propose, events }
}

test('a denied worker git write returns a typed error naming swarm_submit and leaves submission working', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
  await f.workers.callbacks.toolRun(f.author.id, deniedCommit)
  const [denied] = f.events('task/git-write-denied')
  assert.ok(denied, 'the denial is durably recorded')
  assert.equal(denied.data.taskId, task.id)
  assert.equal(denied.data.attemptId, task.attempt.id)
  assert.match(denied.data.command, /git commit/)
  // Pre-fix the guard returned undefined and the worker saw only the raw EPERM.
  const guard = f.workers.callbacks.guard(f.author.id, 'bash')
  assert.match(guard, /swarm_submit/, 'the typed error names the supported artifact path')
  assert.match(guard, /git metadata|index\.lock|EPERM/)
  assert.doesNotMatch(guard, /^fatal:/, 'the raw sandbox error is not surfaced as the whole message')
  assert.equal(f.workers.callbacks.guard(f.author.id, 'swarm_submit'), undefined, 'submission stays available')
  const notice = await eventually(() => f.workers.deliveries.find(item => item.memberId === f.author.id
    && /swarm_submit/.test(item.delivery.content)), 'the worker receives the actionable notice')
  assert.match(notice.delivery.content, /cannot write git metadata/)
  const submitted = await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: task.attempt.id, output: 'workspace captured host-side' })
  assert.equal(submitted.status, 'submitted', 'artifact publication never depends on a worker-side commit')
  assert.equal(submitted.artifact.commit, f.workers.artifact.commit)
})

test('the assignment instructions state the git-write constraint before the worker tries', async t => {
  const f = await fixture(t)
  await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
  const assignment = await eventually(() => f.workers.deliveries.find(item => item.delivery.kind === 'assignment' && item.memberId === f.author.id),
    'the worker received its assignment')
  const { instructions } = JSON.parse(assignment.delivery.content)
  assert.match(instructions, /cannot write git metadata/)
  assert.match(instructions, /index\.lock EPERM/)
  assert.match(instructions, /swarm_submit/)
})

test('read-only git commands and unrelated failures never claim the typed denial path', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
  await f.workers.callbacks.toolRun(f.author.id, { ...deniedCommit, arguments: { command: 'git status --porcelain' } })
  await f.workers.callbacks.toolRun(f.author.id, { ...deniedCommit, arguments: { command: 'npm install' } })
  await f.workers.callbacks.toolRun(f.author.id, { ...deniedCommit, arguments: { command: 'git commit -m "no denial here"' }, result: { isError: false, content: 'committed' }, isError: false })
  assert.equal(f.events('task/git-write-denied').length, 0)
  assert.equal(f.workers.callbacks.guard(f.author.id, 'bash'), undefined)
  assert.equal(f.runtime.store.get('tasks', task.id).gitWriteDenied, undefined)
})

test('a new attempt starts without the previous attempt git-write denial', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
  await f.workers.callbacks.toolRun(f.author.id, deniedCommit)
  assert.match(f.workers.callbacks.guard(f.author.id, 'bash'), /swarm_submit/)
  f.runtime.handoff(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: task.attempt.id, to: f.reviewer.id, summary: 'Reassign after the sandbox denial' })
  await eventually(() => {
    const current = f.runtime.store.get('tasks', task.id)
    return current.status === 'pending' ? current : undefined
  }, 'the handoff re-pends the task')
  const claimed = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, task.id)
  assert.equal(claimed.gitWriteDenied, undefined, 'the marker is cleared when the new attempt is admitted')
  assert.equal(f.workers.callbacks.guard(f.reviewer.id, 'bash'), undefined, 'the new owner is not denied for the old attempt')
})
