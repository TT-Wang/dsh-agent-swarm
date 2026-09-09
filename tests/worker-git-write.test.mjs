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

const SHELL = 'bash'
const NON_SHELL = ['edit', 'grep', 'read', 'write', 'job_output']
const quotedPhrase = [
  'Never run git',
  'add/commit in your worktree: the sandbox cannot write git metadata',
  '(index.lock EPERM).',
].join(' ')
const readOnlyCommand = 'git status --porcelain'
const realAddCommand = [
  'git',
  'add -A',
].join(' ')
const realCommitCommand = [
  'git',
  'commit -m "already done"',
].join(' ')
const refusalText = [
  'index',
  '.lock: Operation not permitted',
].join('')

test('F14: a non-shell tool quoting a git-write phrase with refusal text never denies or latches', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
  for (const tool of NON_SHELL) {
    await f.workers.callbacks.toolRun(f.author.id, {
      tool,
      arguments: { file_path: 'src/tools.ts', pattern: quotedPhrase, new_string: quotedPhrase, command: quotedPhrase },
      result: { isError: false, content: [{ type: 'text', text: quotedPhrase }] },
      isError: false,
    })
  }
  assert.equal(f.events('task/git-write-denied').length, 0, 'a quoted phrase was never executed')
  assert.equal(f.runtime.store.get('tasks', task.id).gitWriteDenied, undefined)
  for (const tool of [SHELL, ...NON_SHELL]) assert.equal(f.workers.callbacks.guard(f.author.id, tool), undefined, `${tool} must not be latched`)
})

test('F14: only the executed shell command decides; a quoting side argument or a successful command never denies', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
  await f.workers.callbacks.toolRun(f.author.id, {
    tool: SHELL,
    arguments: { command: readOnlyCommand, description: quotedPhrase },
    result: { isError: true, content: [{ type: 'text', text: refusalText }] },
    isError: true,
  })
  await f.workers.callbacks.toolRun(f.author.id, {
    tool: SHELL,
    arguments: { command: realCommitCommand },
    result: { isError: false, content: [{ type: 'text', text: 'committed' }] },
    isError: false,
  })
  assert.equal(f.events('task/git-write-denied').length, 0, 'a read-only or successful command is not a denial')
  assert.equal(f.workers.callbacks.guard(f.author.id, SHELL), undefined)
  await f.workers.callbacks.toolRun(f.author.id, {
    tool: 'pwsh',
    arguments: { command: realAddCommand },
    result: { isError: true, content: [{ type: 'text', text: refusalText }] },
    isError: true,
  })
  assert.equal(f.events('task/git-write-denied').length, 1, 'a real shell write is still denied exactly once')
  assert.match(f.workers.callbacks.guard(f.author.id, SHELL), /swarm_submit/)
  assert.equal(f.workers.callbacks.guard(f.author.id, 'swarm_submit'), undefined)
})

const grepPhraseCommand = [
  'grep -rn "Never run git',
  'add/commit ... index.lock EPERM" src/runtime.ts',
].join(' ')
const compoundCommand = [
  'cd src &&',
  'git',
  'add -A',
].join(' ')

test('F14: a quoted pattern is data while a compound command still denies', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
  await f.workers.callbacks.toolRun(f.author.id, {
    tool: SHELL,
    arguments: { command: grepPhraseCommand },
    result: { isError: true, content: [{ type: 'text', text: refusalText }] },
    isError: true,
  })
  assert.equal(f.events('task/git-write-denied').length, 0, 'a quoted search pattern is not a command')
  assert.equal(f.workers.callbacks.guard(f.author.id, SHELL), undefined)
  await f.workers.callbacks.toolRun(f.author.id, {
    tool: SHELL,
    arguments: { command: compoundCommand },
    result: { isError: true, content: [{ type: 'text', text: refusalText }] },
    isError: true,
  })
  assert.equal(f.events('task/git-write-denied').length, 1, 'a compound command still denies')
  assert.match(f.workers.callbacks.guard(f.author.id, SHELL), /swarm_submit/)
})

// R6-01: the denial must not depend on text in the command's OUTPUT. A failing
// command that merely prints the guard's own refusal phrase is data, not a
// sandbox refusal, so it must not deny and must not latch the attempt. Both
// commands are read-only or worktree-only, so no sandbox metadata write was
// attempted either; the pre-fix guard denied on the output text alone.
const outputBorneCommands = [
  'git diff 9fb85d5 803c037 -- src/runtime.ts | git apply --reject --verbose; cat src/runtime.ts.rej',
  'git worktree list --porcelain',
]

test('R6-01: a failing command whose output quotes the refusal text never denies or latches', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
  for (const command of outputBorneCommands) {
    await f.workers.callbacks.toolRun(f.author.id, {
      tool: SHELL,
      arguments: { command },
      result: { isError: true, content: [{ type: 'text', text: `${quotedPhrase} ${refusalText}` }] },
      isError: true,
    })
  }
  assert.equal(f.events('task/git-write-denied').length, 0, 'output text never claims the typed denial')
  assert.equal(f.runtime.store.get('tasks', task.id).gitWriteDenied, undefined, 'the attempt is not latched')
  assert.equal(f.workers.callbacks.guard(f.author.id, SHELL), undefined)
})

test('R6-01: a real git add through bash is still denied once with the typed durable event', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
  await f.workers.callbacks.toolRun(f.author.id, {
    tool: SHELL,
    arguments: { command: realAddCommand },
    result: { isError: true, content: [{ type: 'text', text: refusalText }] },
    isError: true,
  })
  const denied = f.events('task/git-write-denied')
  assert.equal(denied.length, 1, 'the real write is durably recorded exactly once')
  assert.equal(denied[0].data.taskId, task.id)
  assert.match(denied[0].data.command, /git add/)
  assert.equal(f.runtime.store.get('tasks', task.id).gitWriteDenied.command, realAddCommand)
  assert.match(f.workers.callbacks.guard(f.author.id, SHELL), /swarm_submit/)
})

test('R6-01: the denial no longer depends on the failure output text', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
  // A real commit that fails without any sandbox refusal vocabulary in its
  // output is still a denied git write; pre-fix it was not, because the guard
  // required the refusal text, so this test fails on the pre-fix head.
  await f.workers.callbacks.toolRun(f.author.id, {
    tool: SHELL,
    arguments: { command: realCommitCommand },
    result: { isError: true, content: [{ type: 'text', text: 'fatal: cannot lock ref, repository is busy' }] },
    isError: true,
  })
  const [denied] = f.events('task/git-write-denied')
  assert.ok(denied, 'a failed metadata write denies without output-borne refusal text')
  assert.equal(denied.data.taskId, task.id)
  assert.match(denied.data.command, /git commit/)
  assert.match(f.workers.callbacks.guard(f.author.id, SHELL), /swarm_submit/)
})

// R6-02: only the git SUBCOMMAND at command position counts. A read-only
// command that merely mentions a write word in a pattern, path or argument is
// data, not an attempted write, and must never deny or latch. Pre-fix (the
// e2c3ffcb head) each of these denied because GIT_WRITE matched the mention.
const incidentalWriteMentions = [
  'git grep add',
  'git log --grep=commit',
  'git log --oneline --grep=reset',
  'git show HEAD --format=%s | grep add',
  'git diff --stat | grep reset',
]

test('R6-02: a failing read-only command that merely mentions a write word never denies or latches', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
  for (const command of incidentalWriteMentions) {
    await f.workers.callbacks.toolRun(f.author.id, {
      tool: SHELL,
      arguments: { command },
      result: { isError: true, content: [{ type: 'text', text: 'fatal: no matches found in the working tree' }] },
      isError: true,
    })
  }
  assert.equal(f.events('task/git-write-denied').length, 0, 'a mention in an argument is not an executed write')
  assert.equal(f.runtime.store.get('tasks', task.id).gitWriteDenied, undefined, 'the attempt is not latched')
  assert.equal(f.workers.callbacks.guard(f.author.id, SHELL), undefined)
})

const positionedWriteCommand = 'git -C /repo commit -m "already done"'

test('R6-02: a metadata write at subcommand position still denies once after global options', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
  await f.workers.callbacks.toolRun(f.author.id, {
    tool: SHELL,
    arguments: { command: positionedWriteCommand },
    result: { isError: true, content: [{ type: 'text', text: 'fatal: cannot lock ref, repository is busy' }] },
    isError: true,
  })
  const denied = f.events('task/git-write-denied')
  assert.equal(denied.length, 1, 'a write at subcommand position is durably recorded exactly once')
  assert.equal(denied[0].data.taskId, task.id)
  assert.match(denied[0].data.command, /commit/)
  assert.equal(f.runtime.store.get('tasks', task.id).gitWriteDenied.command, positionedWriteCommand)
  assert.match(f.workers.callbacks.guard(f.author.id, SHELL), /swarm_submit/)
})

// R6-I2c: the git token must be the COMMAND. A segment whose preceding tokens
// are not env assignments or known wrappers runs some other program, so a bare
// git token in its arguments is data and must never deny or latch. Pre-fix
// (5f648934) `tokens.indexOf('git')` accepted it anywhere in the segment.
const argumentPositionGit = [
  'grep -rn git add .',
  'rg git add',
  'rg -e git -e add',
  'grep -rn -e git -e add .',
  'rg -w git add',
  'cat git commit',
  'echo git commit',
  'sed -n 1p git commit',
]

test('R6-I2c: a git token that is an argument, not the command, never denies or latches', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
  for (const command of argumentPositionGit) {
    await f.workers.callbacks.toolRun(f.author.id, {
      tool: SHELL,
      arguments: { command },
      result: { isError: true, content: [{ type: 'text', text: 'fatal: no such file or directory' }] },
      isError: true,
    })
  }
  assert.equal(f.events('task/git-write-denied').length, 0, 'an argument token is not an executed write')
  assert.equal(f.runtime.store.get('tasks', task.id).gitWriteDenied, undefined, 'the attempt is not latched')
  assert.equal(f.workers.callbacks.guard(f.author.id, SHELL), undefined)
})

const wrapperGitWrites = [
  'sudo git commit -m "already done"',
  'FOO=1 git commit -m "already done"',
  'env git commit -m "already done"',
  'command git commit -m "already done"',
  'nohup git add -A',
]

test('R6-I2c: wrapper forms still deny exactly once at command position', async t => {
  for (const command of wrapperGitWrites) {
    const f = await fixture(t)
    const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
    await f.workers.callbacks.toolRun(f.author.id, {
      tool: SHELL,
      arguments: { command },
      result: { isError: true, content: [{ type: 'text', text: 'fatal: cannot lock ref, repository is busy' }] },
      isError: true,
    })
    const denied = f.events('task/git-write-denied')
    assert.equal(denied.length, 1, `${command} denies exactly once`)
    assert.equal(denied[0].data.taskId, task.id)
    assert.equal(f.runtime.store.get('tasks', task.id).gitWriteDenied.command, command)
  }
})
