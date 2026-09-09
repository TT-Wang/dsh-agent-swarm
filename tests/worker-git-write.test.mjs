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

// R7-01: a heredoc body is data, never an executed command line. A runbook
// written with `cat > file <<'EOF'` that contains line-start `git add` /
// `git commit` lines must not deny or latch, even when another command in the
// same bash call fails. Pre-fix (e64643c) `unquotedShellText` stripped quotes
// and comments but not heredoc bodies, so `gitWriteSubcommand` split the body
// on newlines and classified the runbook text as a metadata write at command
// position; the failing `false` then denied and latched the attempt.
const runbookBody = [
  '# runbook',
  'git add src/runtime.ts',
  'git commit -m wip',
  'EOF',
]
const runbookHeredocAlone = ["cat > /tmp/notes.md <<'EOF'", ...runbookBody].join('\n')
const runbookHeredocFailing = [runbookHeredocAlone, 'false'].join('\n')

test('R7-01: a heredoc body naming git writes never denies or latches, even when another command fails', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
  await f.workers.callbacks.toolRun(f.author.id, {
    tool: SHELL,
    arguments: { command: runbookHeredocFailing },
    result: { isError: true, content: [{ type: 'text', text: 'fatal: the unrelated trailing command failed' }] },
    isError: true,
  })
  assert.equal(f.events('task/git-write-denied').length, 0, 'heredoc body text was never executed')
  assert.equal(f.runtime.store.get('tasks', task.id).gitWriteDenied, undefined, 'the attempt is not latched')
  for (const tool of [SHELL, 'edit', 'read', 'swarm_submit']) {
    assert.equal(f.workers.callbacks.guard(f.author.id, tool), undefined, `${tool} stays available`)
  }
})

test('R7-01: the same heredoc without a failing command stays allowed', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
  await f.workers.callbacks.toolRun(f.author.id, {
    tool: SHELL,
    arguments: { command: runbookHeredocAlone },
    result: { isError: false, content: [{ type: 'text', text: 'wrote /tmp/notes.md' }] },
    isError: false,
  })
  assert.equal(f.events('task/git-write-denied').length, 0, 'a successful heredoc write is allowed')
  assert.equal(f.runtime.store.get('tasks', task.id).gitWriteDenied, undefined)
  assert.equal(f.workers.callbacks.guard(f.author.id, SHELL), undefined)
})

test('R7-01: a real write after the heredoc terminator still denies exactly once', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
  const command = [runbookHeredocAlone, 'git add -A'].join('\n')
  await f.workers.callbacks.toolRun(f.author.id, {
    tool: SHELL,
    arguments: { command },
    result: { isError: true, content: [{ type: 'text', text: 'fatal: cannot lock ref, repository is busy' }] },
    isError: true,
  })
  const denied = f.events('task/git-write-denied')
  assert.equal(denied.length, 1, 'the executed write after the terminator is durably recorded exactly once')
  assert.equal(denied[0].data.taskId, task.id)
  assert.equal(f.runtime.store.get('tasks', task.id).gitWriteDenied.command, command)
  assert.match(f.workers.callbacks.guard(f.author.id, SHELL), /swarm_submit/)
})

test('R7-01: a real git write whose stdin is a heredoc still denies exactly once', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
  const command = ["git commit -m wip <<'EOF'", 'git add src/runtime.ts', 'EOF'].join('\n')
  await f.workers.callbacks.toolRun(f.author.id, {
    tool: SHELL,
    arguments: { command },
    result: { isError: true, content: [{ type: 'text', text: 'fatal: cannot lock ref, repository is busy' }] },
    isError: true,
  })
  const denied = f.events('task/git-write-denied')
  assert.equal(denied.length, 1, 'the command line itself is still an executed write')
  assert.equal(f.runtime.store.get('tasks', task.id).gitWriteDenied.command, command)
})

test('R7-01: unquoted, tab-stripped and multiple heredoc bodies are all data', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
  const command = [
    'cat <<-EOF > /tmp/a.md',
    '\tgit add src/runtime.ts',
    '\tgit commit -m wip',
    '\tEOF',
    'cat <<PY',
    'git add -A',
    'PY',
    'false',
  ].join('\n')
  await f.workers.callbacks.toolRun(f.author.id, {
    tool: SHELL,
    arguments: { command },
    result: { isError: true, content: [{ type: 'text', text: 'fatal: the unrelated trailing command failed' }] },
    isError: true,
  })
  assert.equal(f.events('task/git-write-denied').length, 0, 'quoted, unquoted and tab-stripped bodies are all data')
  assert.equal(f.runtime.store.get('tasks', task.id).gitWriteDenied, undefined)
  assert.equal(f.workers.callbacks.guard(f.author.id, SHELL), undefined)
})

// R7-01 false-positive direction: `<<<` here-strings, arithmetic left shifts
// and `((...))` arithmetic commands are not heredoc operators, so they must not
// swallow the executed command that follows them.
const notHeredocThenWrite = [
  'echo $((1<<2)) && git commit -m "already done"',
  'cat <<< "notes" && git add -A',
  '((x<<y)) && git commit -m "already done"',
]

test('R7-01: a here-string or arithmetic shift never hides a later real write', async t => {
  for (const command of notHeredocThenWrite) {
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
    assert.equal(f.runtime.store.get('tasks', task.id).gitWriteDenied.command, command)
  }
})

// R7-01b: `<<<` and arithmetic shifts are not heredoc operators. A scanner that
// pairs the second and third `<` of `<<<`, or reads `<<` as a shift and queues a
// phantom heredoc, skips the rest of the call looking for a terminator that does
// not exist, so a real metadata write on a later line records no denial and no
// latch. On the blocked artifact cc59bb8 every command below records denied=0;
// on the pre-guard head e64643c every one denies once.
const hereStringOrArithmeticThenWrite = [
  ['cat <<< notes', 'git add -A'],
  ['cat <<< "notes"', 'git commit -m wip'],
  ['read -r line <<< "$out"', 'git commit -m wip'],
  ['grep -q needle <<< "$haystack"', 'git add -A'],
  ['while IFS= read -r l <<< "$data"; do :; done', 'git commit -m wip'],
  ['echo $((x << y ))', 'git commit -m wip'],
  ['((x << y ))', 'git add -A'],
  ['for ((i=0; i << n; i++)); do :; done', 'git commit -m wip'],
].map(lines => lines.join('\n'))

test('R7-01b: a here-string or arithmetic operator never swallows a later real write', async t => {
  for (const command of hereStringOrArithmeticThenWrite) {
    const f = await fixture(t)
    const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
    await f.workers.callbacks.toolRun(f.author.id, {
      tool: SHELL,
      arguments: { command },
      result: { isError: true, content: [{ type: 'text', text: 'fatal: cannot lock ref, repository is busy' }] },
      isError: true,
    })
    const denied = f.events('task/git-write-denied')
    assert.equal(denied.length, 1, `${command.split('\n')[0]} still denies the later write exactly once`)
    assert.equal(denied[0].data.taskId, task.id)
    assert.equal(f.runtime.store.get('tasks', task.id).gitWriteDenied.command, command, 'the executed command is latched')
    assert.match(f.workers.callbacks.guard(f.author.id, SHELL), /swarm_submit/)
  }
})

// R7-01b: an operator followed by other text on the same line is still a real
// heredoc, and its body is data. On the blocked artifact cc59bb8 each of these
// falsely denies because the operator was not recognized.
const legalHeredocThenFail = [
  ["cat > /tmp/runbook.md <<'EOF' # runbook", 'git add src/runtime.ts', 'git commit -m wip', 'EOF', 'false'],
  ['x=$(cat <<EOF)', 'git add src/runtime.ts', 'git commit -m wip', 'EOF', ')', 'false'],
  ['cat > /tmp/notes.md <<1', 'git add src/runtime.ts', 'git commit -m wip', '1', 'false'],
  ['cat > /tmp/notes.md <<E-O', 'git add src/runtime.ts', 'git commit -m wip', 'E-O', 'false'],
].map(lines => lines.join('\n'))

test('R7-01b: a heredoc operator followed by other text still makes its body data', async t => {
  for (const command of legalHeredocThenFail) {
    const f = await fixture(t)
    const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
    await f.workers.callbacks.toolRun(f.author.id, {
      tool: SHELL,
      arguments: { command },
      result: { isError: true, content: [{ type: 'text', text: 'fatal: the unrelated trailing command failed' }] },
      isError: true,
    })
    assert.equal(f.events('task/git-write-denied').length, 0, `${command.split('\n')[0]} body is data`)
    assert.equal(f.runtime.store.get('tasks', task.id).gitWriteDenied, undefined, 'the attempt is not latched')
    assert.equal(f.workers.callbacks.guard(f.author.id, SHELL), undefined)
  }
})

// R7-01b over-fix tripwire: recognizing these operators must not swallow a real
// write that follows the terminator line.
const legalHeredocThenWrite = [
  ['x=$(cat <<EOF)', 'git add src/runtime.ts', 'git commit -m wip', 'EOF', ')', 'git add -A'],
  ['cat > /tmp/notes.md <<1', 'git add src/runtime.ts', '1', 'git commit -m wip'],
  ["cat > /tmp/notes.md <<'E-O'", 'git commit -m wip', 'E-O', 'git add -A'],
].map(lines => lines.join('\n'))

test('R7-01b: a real write after a legal heredoc terminator still denies exactly once', async t => {
  for (const command of legalHeredocThenWrite) {
    const f = await fixture(t)
    const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
    await f.workers.callbacks.toolRun(f.author.id, {
      tool: SHELL,
      arguments: { command },
      result: { isError: true, content: [{ type: 'text', text: 'fatal: cannot lock ref, repository is busy' }] },
      isError: true,
    })
    const denied = f.events('task/git-write-denied')
    assert.equal(denied.length, 1, `${command.split('\n')[0]} still denies the write after the terminator`)
    assert.equal(f.runtime.store.get('tasks', task.id).gitWriteDenied.command, command)
  }
})

// R7-01b: an operator whose terminator line never appears is not a heredoc; the
// text stays commands so a later real write is still seen. On the blocked
// artifact cc59bb8 the missing terminator swallowed the rest of the call.
test('R7-01b: an unterminated heredoc never swallows a later real write', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
  const command = ['cat <<EOF', 'git add -A'].join('\n')
  await f.workers.callbacks.toolRun(f.author.id, {
    tool: SHELL,
    arguments: { command },
    result: { isError: true, content: [{ type: 'text', text: 'fatal: cannot lock ref, repository is busy' }] },
    isError: true,
  })
  const denied = f.events('task/git-write-denied')
  assert.equal(denied.length, 1, 'the later write is still seen when no terminator line exists')
  assert.equal(f.runtime.store.get('tasks', task.id).gitWriteDenied.command, command)
})

// R7-01b: spaced, backslash-quoted and tab-stripped delimiters are real
// heredocs, so their bodies are data. These fail on the pre-guard head.
const delimiterFormsThenFail = [
  ['cat > /tmp/notes.md << EOF', 'git add src/runtime.ts', 'git commit -m wip', 'EOF', 'false'],
  ['cat > /tmp/notes.md <<\\EOF', 'git add src/runtime.ts', 'git commit -m wip', 'EOF', 'false'],
  ['cat > /tmp/notes.md <<-"EOF"', '\tgit add src/runtime.ts', '\tgit commit -m wip', '\tEOF', 'false'],
].map(lines => lines.join('\n'))

test('R7-01b: spaced, backslash-quoted and tab-stripped delimiters make their bodies data', async t => {
  for (const command of delimiterFormsThenFail) {
    const f = await fixture(t)
    const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
    await f.workers.callbacks.toolRun(f.author.id, {
      tool: SHELL,
      arguments: { command },
      result: { isError: true, content: [{ type: 'text', text: 'fatal: the unrelated trailing command failed' }] },
      isError: true,
    })
    assert.equal(f.events('task/git-write-denied').length, 0, `${command.split('\n')[0]} body is data`)
    assert.equal(f.runtime.store.get('tasks', task.id).gitWriteDenied, undefined)
    assert.equal(f.workers.callbacks.guard(f.author.id, SHELL), undefined)
  }
})

test('R7-01b: a here-string without a space never hides a later real write', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
  const command = ['cat <<<notes', 'git add -A'].join('\n')
  await f.workers.callbacks.toolRun(f.author.id, {
    tool: SHELL,
    arguments: { command },
    result: { isError: true, content: [{ type: 'text', text: 'fatal: cannot lock ref, repository is busy' }] },
    isError: true,
  })
  const denied = f.events('task/git-write-denied')
  assert.equal(denied.length, 1, 'a spaceless here-string still denies the later write exactly once')
  assert.equal(f.runtime.store.get('tasks', task.id).gitWriteDenied.command, command)
})

// R7-01c: `$[...]` (deprecated arithmetic expansion) and unquoted `${...}` are
// literal spans in bash, so a `<<` inside them is data. The blocked R7-01b
// artifact 8b07c2f still queued a phantom heredoc there (and the later line
// supplied the missing terminator), so a real write on the later line recorded
// denied=0. Each shape below therefore fails on 8b07c2f and denies on e64643c.
const literalSpanThenWrite = [
  ['echo $[1 << 2 ]', 'git commit -m wip', '2'],
  ['echo ${x:-1 << 2 }', 'git commit -m wip', '2'],
  ['echo ${x:-a << b }', 'git commit -m wip', 'b'],
  ['echo $[a << b ]', 'git commit -m wip', 'b'],
  ['echo $[(1<<2)]', 'git commit -m wip', '2'],
  ['printf "%s\\n" $[1 << 2 ]', 'git commit -m wip', '2'],
].map(lines => lines.join('\n'))

test('R7-01c: $[...] and unquoted ${...} are literal spans, not heredoc operators', async t => {
  for (const command of literalSpanThenWrite) {
    const f = await fixture(t)
    const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
    await f.workers.callbacks.toolRun(f.author.id, {
      tool: SHELL,
      arguments: { command },
      result: { isError: true, content: [{ type: 'text', text: 'fatal: cannot lock ref, repository is busy' }] },
      isError: true,
    })
    const denied = f.events('task/git-write-denied')
    assert.equal(denied.length, 1, `${command.split('\n')[0]} still denies the later write exactly once`)
    assert.equal(denied[0].data.taskId, task.id)
    assert.equal(f.runtime.store.get('tasks', task.id).gitWriteDenied.command, command, 'the executed command is latched')
    assert.match(f.workers.callbacks.guard(f.author.id, SHELL), /swarm_submit/)
  }
})

// R7-01c controls: `$((...))` arithmetic is already a tracked span and must
// keep denying after the literal-span change.
const arithmeticSpanControls = [
  ['echo $((1 << 2 ))', 'git commit -m wip', '2'],
  ['echo $((a << b ))', 'git commit -m wip', 'b'],
].map(lines => lines.join('\n'))

test('R7-01c: arithmetic $((...)) controls still deny exactly once', async t => {
  for (const command of arithmeticSpanControls) {
    const f = await fixture(t)
    const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
    await f.workers.callbacks.toolRun(f.author.id, {
      tool: SHELL,
      arguments: { command },
      result: { isError: true, content: [{ type: 'text', text: 'fatal: cannot lock ref, repository is busy' }] },
      isError: true,
    })
    const denied = f.events('task/git-write-denied')
    assert.equal(denied.length, 1, `${command.split('\n')[0]} control denies exactly once`)
    assert.equal(f.runtime.store.get('tasks', task.id).gitWriteDenied.command, command)
  }
})

// R7-01c: literal spans are not heredocs themselves, so a real heredoc after
// one still makes its body data.
const legalHeredocAfterLiteral = [
  ['echo ${x:-a} && cat <<EOF', 'git add src/runtime.ts', 'git commit -m wip', 'EOF', 'false'],
  ['echo $[1] && cat <<EOF', 'git add src/runtime.ts', 'git commit -m wip', 'EOF', 'false'],
].map(lines => lines.join('\n'))

test('R7-01c: a legal heredoc after a literal span still makes its body data', async t => {
  for (const command of legalHeredocAfterLiteral) {
    const f = await fixture(t)
    const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
    await f.workers.callbacks.toolRun(f.author.id, {
      tool: SHELL,
      arguments: { command },
      result: { isError: true, content: [{ type: 'text', text: 'fatal: the unrelated trailing command failed' }] },
      isError: true,
    })
    assert.equal(f.events('task/git-write-denied').length, 0, `${command.split('\n')[0]} body is data`)
    assert.equal(f.runtime.store.get('tasks', task.id).gitWriteDenied, undefined)
    assert.equal(f.workers.callbacks.guard(f.author.id, SHELL), undefined)
  }
})

const literalThenHeredocThenWrite = [
  ['echo ${x:-a} && cat <<EOF', 'git add src/runtime.ts', 'EOF', 'git commit -m wip'],
  ['echo $[1] && cat <<EOF', 'git add src/runtime.ts', 'EOF', 'git add -A'],
].map(lines => lines.join('\n'))

test('R7-01c: a real write after a literal span and a heredoc terminator still denies once', async t => {
  for (const command of literalThenHeredocThenWrite) {
    const f = await fixture(t)
    const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
    await f.workers.callbacks.toolRun(f.author.id, {
      tool: SHELL,
      arguments: { command },
      result: { isError: true, content: [{ type: 'text', text: 'fatal: cannot lock ref, repository is busy' }] },
      isError: true,
    })
    const denied = f.events('task/git-write-denied')
    assert.equal(denied.length, 1, `${command.split('\n')[0]} still denies the write after the terminator`)
    assert.equal(f.runtime.store.get('tasks', task.id).gitWriteDenied.command, command)
  }
})
