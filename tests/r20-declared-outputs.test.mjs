/**
 * R20: a task declares the files it must produce.
 *
 * Before this, nothing on a task named its deliverables, so five consumers read
 * them out of the objective and acceptance prose with a write-verb heuristic
 * whose edge cases were patched from round 4 to round 19. `outputs` states the
 * same list exactly, validated once at admission, and since R24 it is the only
 * rule: the heuristic is deleted and a row without the field declares no output.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { validatePlan } from '../lib/plans.js'
import { registerTools } from '../lib/tools.js'
import { runProcess } from '../lib/workspaces.js'
import { subprocessSeam } from './subprocess-seam.mjs'
import { assessText, toolSchemaIndex } from './refusal-inventory.mjs'
import { makeWorkspaces } from './faults/harness.mjs'

const schemaIndex = await toolSchemaIndex()
/** The refusal is `[output_outside_scope]`, and its rendered text satisfies the refusal contract. */
const outsideScope = error => {
  assert.match(error.message, /\[output_outside_scope\]/)
  // One code, one category: a non-array and a bad entry are both malformed caller input.
  assert.equal(error.code, 'output_outside_scope')
  assert.equal(error.category, 'validation_error')
  assert.deepEqual(assessText(error.message, schemaIndex), [], `the rendered refusal satisfies the refusal contract: ${error.message}`)
  return true
}

const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 20, maxExperiments: 2 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function eventually(read, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > deadline) assert.fail(message)
    await sleep(10)
  }
}

function plan(workspace, overrides = {}) {
  return {
    title: 'Declared outputs', objective: 'Deliver verified code', workspace, scope: ['src/'], acceptance: ['works'], budget,
    members: [{ key: 'builder', name: 'Builder', role: 'implementation' }, { key: 'reviewer', name: 'Reviewer', role: 'verification' }],
    workstreams: [{ key: 'main', title: 'Delivery', objective: 'Complete the change' }],
    tasks: [
      { key: 'review', workstreamKey: 'main', title: 'Review', objective: 'Verify artifact', kind: 'verification',
        scope: ['src/'], acceptance: ['works'], outputs: [], assigneeKey: 'reviewer', reviewOf: 'code' },
      { key: 'code', workstreamKey: 'main', title: 'Deliver', objective: 'Implement change', kind: 'integration',
        scope: ['src/'], acceptance: ['works'], outputs: ['src/change.ts'], assigneeKey: 'builder', checks: ['node check.cjs'] },
    ],
    ...overrides,
  }
}

class Workers {
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(_mission, id) { return `/isolated/${id}` }
  async start() {}
  async deliver() {}
  async stop() {}
  isIdle() { return true }
  async captureArtifact() { return { commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: [] } }
  async verifyArtifact() { return [] }
  async prepareTask() {}
  async dispose() {}
}

async function runtimeFixture(t, config = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-r20-outputs-')))
  const runtime = new SwarmRuntime({ statePath: path.join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 25,
    maxMessageChars: 16000, maxEvents: 500, maxTasksPerMember: 9, ...config }, new Workers())
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  await runtime.start()
  const owner = { sessionId: 'r20-outputs-owner' }
  const mission = runtime.create(owner, { title: 'Outputs', objective: 'Declare deliverables', workspace: directory,
    scope: ['src/', 'docs/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const addMember = name => runtime.addMember(owner, mission.id, { name, role: 'implementation' })
  const propose = (title, input = {}) => runtime.propose(owner, mission.id, { workstreamId: stream.id, title, objective: title,
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test -d .'], ...input })
  return { directory, runtime, owner, mission, stream, addMember, propose }
}

test('R20: a declared output outside the task scope is refused at plan validation and at propose', async t => {
  const outside = plan('/workspace')
  outside.tasks[1].outputs = ['src/change.ts', 'docs/report.md']
  assert.throws(() => validatePlan(outside), outsideScope, 'plan validation refuses a deliverable the task may not write')
  assert.throws(() => validatePlan(outside), /docs\/report\.md/, 'the refusal names the offending path')
  assert.deepEqual(validatePlan(plan('/workspace')).tasks.find(task => task.key === 'code').outputs, ['src/change.ts'],
    'a declared in-scope output survives into the canonical plan')

  const f = await runtimeFixture(t)
  assert.throws(() => f.propose('Audit', { outputs: ['docs/report.md'] }), outsideScope,
    'propose refuses the same declaration, so the error is not deferred to submission')
  // The exact rule replaces the advisory hint: a read-only audit can now declare
  // its report at plan time by putting the path inside its own scope.
  const audit = f.propose('Audit', { kind: 'research', scope: ['docs/'], checks: [], outputs: ['docs/report.md'] })
  assert.deepEqual(f.runtime.store.get('tasks', audit.id).outputs, ['docs/report.md'])
})

test('R20: a declared output must be a literal in-scope file, never a directory, glob, traversal or dependency path', async t => {
  const f = await runtimeFixture(t)
  for (const [declared, why] of [
    ['src/', 'a directory token is not a file'],
    ['src/*.ts', 'a glob is not a literal path'],
    ['src/../etc/passwd', 'a ".." segment could escape the repository'],
    ['src/node_modules/pkg/README.md', 'dependency content is toolchain state, never work'],
    ['src/.swarm-scratch/draft.md', 'the member scratch root is toolchain state too'],
    ['src/.git/config', 'Git metadata is never a deliverable'],
    ['/etc/passwd', 'an absolute path is not repository-relative'],
    ['', 'an empty entry names nothing'],
  ]) {
    assert.throws(() => f.propose(`Refuse ${declared}`, { outputs: [declared] }), outsideScope, why)
    const planned = plan('/workspace')
    planned.tasks[1].outputs = [declared]
    assert.throws(() => validatePlan(planned), outsideScope, `${why} (plan validation)`)
  }
  const notArray = plan('/workspace')
  notArray.tasks[1].outputs = 'src/change.ts'
  assert.throws(() => validatePlan(notArray), outsideScope, 'a declaration that is not an array is refused with the same code')
  assert.ok(f.propose('Analysis only', { kind: 'research', checks: [], outputs: [] }), 'an empty array is a legal declaration')
})

test('R20: a replacement inherits the replaced task\'s outputs', async t => {
  const f = await runtimeFixture(t)
  const original = f.propose('Write the adapter', { outputs: ['src/adapter.ts'] })
  f.runtime.cancel(f.owner, f.mission.id, { taskId: original.id, reason: 'withdrawn so a repair can be admitted' })
  const repair = f.propose('Write the adapter again', { replaces: [original.id] })
  assert.deepEqual(f.runtime.store.get('tasks', repair.id).outputs, ['src/adapter.ts'],
    'a repair that omits outputs keeps the obligation the original declared')
  f.runtime.cancel(f.owner, f.mission.id, { taskId: repair.id, reason: 'withdrawn so a second repair can be admitted' })
  const narrowed = f.propose('Write the adapter differently', { outputs: ['src/adapter2.ts'], replaces: [repair.id] })
  assert.deepEqual(f.runtime.store.get('tasks', narrowed.id).outputs, ['src/adapter2.ts'], 'an explicit declaration is not overwritten')
})

test('R24: propose refuses a new task without outputs on every caller path; a repair may omit them only to inherit a declaration', async t => {
  const f = await runtimeFixture(t)
  const required = error => {
    assert.equal(error.code, 'outputs_required')
    assert.equal(error.category, 'validation_error')
    assert.match(error.message, /^\[outputs_required\] .*Pass `outputs` with `swarm_propose`/)
    assert.deepEqual(assessText(error.message, schemaIndex), [], `the rendered refusal satisfies the refusal contract: ${error.message}`)
    return true
  }
  // A direct caller: nothing reached the store.
  assert.throws(() => f.propose('Undeclared'), required, 'runtime.propose refuses a task that declares no outputs')
  // swarm_propose: outputs is conditional (a repair inherits it), so the
  // schema cannot require it and the runtime refuses a new task without it.
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, f.runtime, budget)
  const tool = definitions.get('swarm_propose')
  assert.equal(tool.parameters.required.includes('outputs'), false)
  await assert.rejects(tool.execute({ missionId: f.mission.id, workstreamId: f.stream.id, title: 'Report', objective: 'Write the audit to docs/audit.md',
    kind: 'research', scope: ['docs/'], acceptance: ['works'] }, { agent: { id: f.owner.sessionId }, signal: new AbortController().signal }), required)
  assert.deepEqual(f.runtime.store.list('tasks', f.mission.id), [], 'no refused proposal was admitted')
  // A repair of a row that declares nothing (a store written before the field
  // existed) has nothing to inherit, so it must declare its own.
  const legacy = f.propose('Legacy work', { outputs: [] })
  const row = f.runtime.store.get('tasks', legacy.id)
  delete row.outputs
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', row))
  f.runtime.cancel(f.owner, f.mission.id, { taskId: legacy.id, reason: 'withdrawn so a repair can be admitted' })
  assert.throws(() => f.propose('Repair without a declaration', { replaces: [legacy.id] }), error => required(error) && /`replaces`/.test(error.message))
  const repair = f.propose('Repair that declares', { replaces: [legacy.id], outputs: ['src/legacy.ts'] })
  assert.deepEqual(f.runtime.store.get('tasks', repair.id).outputs, ['src/legacy.ts'])
})

test('R24: a scope amendment that would leave a declared output outside the task scope is refused unless the same call amends outputs', async t => {
  const f = await runtimeFixture(t)
  const task = f.propose('Report and patch', { kind: 'research', checks: [], scope: ['src/', 'docs/'], outputs: ['docs/report.md', 'src/patch.ts'] })
  const amend = (changes, reason) => f.runtime.controlTask(f.owner, f.mission.id, task.id, 'amend', changes, reason)
  assert.throws(() => amend({ scope: ['src/'] }, 'narrow to the code'), error => {
    outsideScope(error)
    assert.match(error.message, /"docs\/report\.md"/, 'the refusal names the stranded output')
    assert.match(error.message, /Pass `changes` with `outputs` .* same `swarm_control` call/)
    return true
  })
  assert.deepEqual(f.runtime.store.get('tasks', task.id).scope, ['src/', 'docs/'], 'the refused amendment changed nothing')
  // Amending outputs in the same call, or keeping every output inside the new scope, is admitted.
  const narrowed = amend({ scope: ['src/'], outputs: ['src/patch.ts'] }, 'narrow to the code and drop the report')
  assert.deepEqual([narrowed.scope, narrowed.outputs], [['src/'], ['src/patch.ts']])
  const widened = amend({ scope: ['src/', 'docs/'] }, 'widen again')
  assert.deepEqual([widened.scope, widened.outputs], [['src/', 'docs/'], ['src/patch.ts']])
})

test('R24: propose and amend check declared outputs against the host-configured dependency directories', async t => {
  // The host treats gen/ as a dependency directory and no longer vendor/, so
  // capture would skip src/gen/out.txt and capture src/vendor/patch.txt.
  const f = await runtimeFixture(t, { verificationDependencyDirs: ['node_modules', 'gen'] })
  const generated = error => outsideScope(error) && /"gen"/.test(error.message)
  assert.throws(() => f.propose('Generated', { outputs: ['src/gen/out.txt'] }), generated, 'propose refuses a configured dependency name')
  const vendored = f.propose('Vendored patch', { outputs: ['src/vendor/patch.txt'] })
  assert.deepEqual(f.runtime.store.get('tasks', vendored.id).outputs, ['src/vendor/patch.txt'], 'a default name the host removed is ordinary work')
  const amend = changes => f.runtime.controlTask(f.owner, f.mission.id, vendored.id, 'amend', changes, 'adjust the declaration')
  assert.throws(() => amend({ outputs: ['src/gen/out.txt'] }), generated, 'an outputs amendment is checked against the same set')
  assert.deepEqual(amend({ scope: ['src/'] }).outputs, ['src/vendor/patch.txt'], 'a scope amendment re-checks the stored outputs against the same set')
})

test('R20: the host-created automatic review declares no outputs', async t => {
  const f = await runtimeFixture(t)
  // A second independent member makes the host-admitted review admissible, and
  // the submitted task is the only work on the board so the review path stalls.
  const author = await f.addMember('Ada')
  await f.addMember('Grace')
  const source = f.propose('Reviewable work', { assigneeId: author.id, outputs: ['src/work.ts'] })
  const claimed = await f.runtime.claim({ sessionId: author.sessionId }, f.mission.id, source.id)
  await f.runtime.submit({ sessionId: author.sessionId }, f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = await eventually(() => f.runtime.store.list('tasks', f.mission.id).find(item => item.kind === 'verification' && item.reviewOf === source.id),
    'the automatic review is admitted')
  assert.deepEqual(review.outputs, [], 'the host-created review owes no file and says so, rather than inheriting the source text')
})

async function workspaceFixture(t) {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-r20-recovery-')))
  const source = path.join(temp, 'source')
  await mkdir(source)
  const git = async (cwd, ...args) => {
    const result = await runProcess(['git', '-c', 'user.name=Swarm Test', '-c', 'user.email=swarm-test@localhost', ...args],
      { subprocess: subprocessSeam, cwd, timeoutMs: 30000, maxBytes: 100000 })
    assert.equal(result.exitCode, 0, result.output)
    return result.output.trim()
  }
  await git(source, 'init', '-b', 'main')
  await writeFile(path.join(source, '.gitignore'), 'review/\n')
  await writeFile(path.join(source, 'tracked.txt'), 'base\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'initial')
  const workspaces = makeWorkspaces(temp)
  t.after(async () => { await workspaces.dispose(); await rm(temp, { recursive: true, force: true }) })
  const mission = { id: 'mission-r20', workspace: source }
  const member = { id: 'first', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'first') }
  const peer = { id: 'second', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'second') }
  const draft = async (owner, content) => {
    await mkdir(path.join(owner.workspace, 'review'), { recursive: true })
    await writeFile(path.join(owner.workspace, 'review/final.md'), content)
  }
  return { temp, source, workspaces, mission, member, peer, draft, git }
}

test('R20: a declared gitignored report survives a handoff although no task text names it', async t => {
  const f = await workspaceFixture(t)
  // Deliberately mute prose: the draft is preserved only because the task declares the file.
  const task = { id: 'audit', missionId: f.mission.id, epoch: 1, title: 'Audit', objective: 'Audit the scheduler and report what you find',
    acceptance: ['The audit is reported'], outputs: ['review/final.md'], kind: 'research', scope: ['review/'], checks: [], status: 'running' }
  await f.workspaces.prepareTask(f.member, task, [])
  await f.draft(f.member, 'declared draft\n')
  await f.workspaces.checkpointTask(f.member, { ...task, epoch: 2 })
  await f.workspaces.prepareTask(f.peer, { ...task, epoch: 2 }, [])
  assert.equal(await readFile(path.join(f.peer.workspace, 'review/final.md'), 'utf8'), 'declared draft\n',
    'the declared deliverable reaches the replacement worktree')
})

test('R24: a task row with no outputs declares none, so an ignored draft its text names is not preserved', async t => {
  const f = await workspaceFixture(t)
  const legacy = { id: 'legacy', missionId: f.mission.id, epoch: 1, title: 'Draft review', objective: 'Write review/final.md',
    acceptance: ['Deliver review/final.md'], kind: 'research', scope: ['review/'], checks: [], status: 'running' }
  await f.workspaces.prepareTask(f.member, legacy, [])
  await f.draft(f.member, 'legacy draft\n')
  await f.workspaces.checkpointTask(f.member, { ...legacy, epoch: 2 })
  await f.workspaces.prepareTask(f.peer, { ...legacy, epoch: 2 }, [])
  await assert.rejects(readFile(path.join(f.peer.workspace, 'review/final.md'), 'utf8'), { code: 'ENOENT' },
    'the objective prose is no longer read for output paths')
  assert.equal(await readFile(path.join(f.member.workspace, 'review/final.md'), 'utf8'), 'legacy draft\n', 'the file stays in the previous owner worktree')
})

test('R24: no source comment still promises a text-heuristic fallback for a row without outputs', async () => {
  // The write-verb heuristic is deleted: an absent field reads as [] and
  // nothing is inferred, so a comment describing the old fallback misleads.
  const root = new URL('../src/', import.meta.url)
  const files = (await readdir(root, { recursive: true })).filter(file => /\.tsx?$/.test(file))
  const stale = []
  for (const file of files) {
    const text = await readFile(new URL(file, root), 'utf8')
    if (/text heuristic|falling back to the (?:write-verb )?heuristic/i.test(text)) stale.push(file)
  }
  assert.deepEqual(stale, [])
})
