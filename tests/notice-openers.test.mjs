/**
 * Batch 11, step 8: every owner notice names its fact. A notice is keyed by
 * the durable event that triggered it and the reason that opened it, or by an
 * explicit key, never by its class alone: a key only the class names collapses
 * every fact of that class on the same subjects into one, so a second, distinct
 * fact on unchanged subjects (failure 2 after failure 1, a second outage class,
 * a second challenge, another temp path, a new refusal reason or limit) was
 * dropped. The runtime reads the fake clock and runs no tick timer.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { FakeClock, MISSION_ACCEPTANCE, PROJECT, events, setup, taskOf } from './faults/harness.mjs'
import { ownerTools, sessionTools } from './refusal-inventory.mjs'

const ownerRows = (f, pattern) => f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner' && delivery.notice !== undefined && pattern.test(delivery.content))
const fixture = async (t, options = {}) => { const f = await setup({ clock: new FakeClock(), ...options }); t.after(f.cleanup); return f }

test('each start failure below the bound is its own fact, opened by its event: failure 2 after failure 1, and failure 1 of a new run after a successful start', async t => {
  const f = await fixture(t)
  const fail = () => f.runtime.onStartFailure(f.runtime.mission(f.mission.id), f.runtime.store.get('members', f.author.id), new Error('worker could not start'))
  const failures = () => ownerRows(f, /^Author could not start \(failure/).map(delivery => [delivery.content.match(/failure \d of \d/)[0], delivery.subjects])
  const root = [`mission:${f.mission.id}`]
  fail()
  fail()
  assert.deepEqual(failures(), [['failure 1 of 3', root], ['failure 2 of 3', root]], 'the second failure on the same subjects is told')
  // A successful start ends the run (what the start path records); the next failure opens a new one on the same subjects.
  f.runtime.startFailures.delete(f.author.id)
  f.runtime.clearProviderOutage(f.mission.id, f.author.id)
  fail()
  assert.deepEqual(failures(), [['failure 1 of 3', root], ['failure 2 of 3', root], ['failure 1 of 3', root]], 'a new run\'s first failure is told too')
})

test('a provider outage is its class on the member\'s open work, whatever each report\'s text: a retry between scheduling passes, which adopt the running member and record no recovery, and a return to a class already told are that fact; another class, or the class over new work inside the outage event window, is a new one', async t => {
  const f = await fixture(t)
  // The adapter's contract: a start of a member whose session is running adopts it and opens nothing.
  const start = f.workers.start.bind(f.workers)
  f.workers.start = async spec => { const running = f.workers.started.includes(spec.member.id); await start(spec); return running }
  const first = f.propose({ title: 'Running work' })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, first.id)
  const outages = () => ownerRows(f, /^Author provider/).map(delivery => [delivery.content.match(/provider (\S+) outage/)[1], delivery.subjects])
  const subject = task => [`${task.id}@${f.runtime.store.get('tasks', task.id).epoch}`]
  const report = (outage, status, message) => f.workers.callbacks.providerOutage(f.author.id, { class: outage, status, message })
  // What the adapter reports while it retries the preserved attempt in place, a scheduling pass between reports.
  // Each report's text differs by its request id.
  for (let pass = 0; pass < 3; pass++) {
    report('rate-limit', 429, `Rate limit reached for requests. Request id: req_${pass}`)
    f.clock.advance(1_000)
    f.runtime.kick(f.mission.id)
    await f.runtime.settle(f.mission.id)
  }
  assert.ok(f.workers.started.filter(id => id === f.author.id).length > 3, 'each pass started the member, adopting its running session')
  assert.deepEqual([events(f.runtime, f.mission.id, 'provider/outage').length, events(f.runtime, f.mission.id, 'provider/recovered').length], [1, 0],
    'an adoption opened nothing, so it records no recovery, and the window bounds the outage event to one')
  assert.equal(f.runtime.store.get('members', f.author.id).providerOutage?.class, 'rate-limit', 'the outage stays recorded on the member')
  assert.equal(f.runtime.store.get('tasks', first.id).attempt?.id, claimed.attempt.id, 'on the same preserved attempt')
  assert.deepEqual(outages(), [['rate-limit', subject(first)]], 'a retry is the fact the owner holds')
  report('unavailable', 503, 'upstream down')
  report('rate-limit', 429, 'Rate limit reached for requests')
  assert.deepEqual(outages(), [['rate-limit', subject(first)], ['unavailable', subject(first)]], 'another class is told; a return to a class told on this work is not')
  // The member moves to new work with no pass between, still rate-limited.
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: first.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const second = f.propose({ title: 'Next work' })
  await f.runtime.claim(f.actor(f.author), f.mission.id, second.id)
  // Inside the window that bounds the outage event: the window paces the event, never the notice.
  f.clock.advance(1_000)
  const recorded = events(f.runtime, f.mission.id, 'provider/outage').length
  report('rate-limit', 429, 'Rate limit reached for requests. Request id: req_next')
  assert.deepEqual(outages(), [['rate-limit', subject(first)], ['unavailable', subject(first)], ['rate-limit', subject(second)]], 'the class over new work is a new fact')
  assert.equal(events(f.runtime, f.mission.id, 'provider/outage').length, recorded, 'while the repeated class inside the window writes no event')
})

test('each challenge of a claim is its own fact, opened by its event', async t => {
  const f = await fixture(t)
  const source = f.propose({ title: 'Accepted source' })
  f.runtime.commit(f.mission.id, () => {
    f.runtime.store.put('tasks', { ...f.runtime.store.get('tasks', source.id), status: 'accepted', artifact: { ...f.workers.artifact }, evidenceIds: ['e-source'] })
    f.runtime.store.put('evidence', { id: 'e-source', missionId: f.mission.id, taskId: source.id, workstreamId: f.stream.id,
      authorId: f.author.id, claim: 'a finding', outcome: 'supported', status: 'verified', toolRunIds: [], supersedes: [], challenges: [], createdAt: f.clock.now() })
  })
  f.runtime.challenge(f.owner, f.mission.id, { evidenceId: 'e-source', reason: 'counterexample', toolRunIds: [] })
  f.runtime.challenge(f.owner, f.mission.id, { evidenceId: 'e-source', reason: 'counterexample', toolRunIds: [] })
  const challenges = ownerRows(f, /^Evidence e-source challenged/)
  assert.equal(challenges.length, 2, 'the second challenge is told')
  assert.equal(new Set(challenges.map(delivery => JSON.stringify(delivery.subjects))).size, 1, 'on the same subjects')
})

test('a member failure is the member on its open work, whatever the provider text: a failure whose text carries per-request data is that fact again, while another member\'s failure and the member\'s failure over new work are new facts', async t => {
  const f = await fixture(t)
  const failures = () => ownerRows(f, / failed: /).map(delivery => [delivery.content.slice(0, delivery.content.indexOf(' ')), delivery.subjects])
  const root = [`mission:${f.mission.id}`]
  // A provider error the outage classifier does not catch, whose text names the tokens each request asked for.
  for (let turn = 0; turn < 3; turn++) f.workers.callbacks.failure(f.author.id, `This model's maximum context length is 131072 tokens. However, you requested ${131_500 + 700 * turn} tokens. Please reduce the length of the messages.`)
  f.workers.callbacks.failure(f.reviewer.id, 'session crashed')
  assert.deepEqual(failures(), [['Author', root], ['Reviewer', root]], 'one fact per member, each naming the mission root while it holds no work')
  const work = f.propose({ title: 'Assigned work' })
  f.workers.callbacks.failure(f.author.id, 'session crashed')
  f.workers.callbacks.failure(f.author.id, 'provider returned malformed output')
  assert.deepEqual(failures(), [['Author', root], ['Reviewer', root], ['Author', [`${work.id}@${taskOf(f.runtime, work.id).epoch}`]]], 'the member\'s failure over its new work is a new fact, told once')
})

test('a worker\'s refused proposal is one fact per reason and limit, and each exit it names is performed through the registered tools: swarm_control\'s resume and swarm_cancel admit nothing and tell nothing new, swarm_budget admits the work, and a refusal under the raised limit is a new fact', async t => {
  const f = await fixture(t, { budget: { maxTasks: 1 } })
  const owner = await ownerTools(f)
  const worker = await sessionTools(f, f.author.sessionId)
  const held = f.propose({ title: 'Admitted' })
  const proposal = title => ({ outputs: [], workstreamId: f.stream.id, title, objective: 'More work', kind: 'research', scope: ['**'], acceptance: MISSION_ACCEPTANCE, checks: [] })
  const refused = title => assert.rejects(worker('swarm_propose', proposal(title)), /task budget exhausted/)
  const refusals = () => ownerRows(f, /^\[budget_terminal\]/).filter(delivery => delivery.from === f.author.id).map(delivery => delivery.content.match(/was refused: (.*\(limit \d+\))\)/)[1])
  const first = 'mission task budget exhausted (1/1 tasks admitted) (limit 1)'
  await refused('More')
  await refused('More again')
  assert.deepEqual(refusals(), [first], 'the same refusal is told once')
  const [request] = ownerRows(f, /^\[budget_terminal\]/)
  assert.deepEqual([...new Set(request.content.match(/\bswarm_\w+/g))].sort(), ['swarm_budget', 'swarm_cancel', 'swarm_control'], 'the request names these tools')
  assert.match(request.content, /Explicit user pause remains until `swarm_control` with `action: resume`/)
  assert.equal((await owner('swarm_control', { action: 'resume', reason: 'Resume' })).status, 'active', 'the resume is accepted: the mission was never paused')
  await refused('More after the resume')
  assert.deepEqual(refusals(), [first], 'it admits nothing, and the refusal is still the one the owner holds')
  assert.match(request.content, /Use `swarm_cancel` with `taskId` and `reason` to withdraw mistaken work; cancellation never resets consumed budget/)
  await owner('swarm_cancel', { taskId: held.id, reason: 'Withdrawn' })
  assert.equal(taskOf(f.runtime, held.id).status, 'cancelled', 'the work is withdrawn')
  await refused('More after the cancel')
  assert.deepEqual(refusals(), [first], 'and, as the request says, its admission is not given back')
  assert.match(request.content, /`swarm_budget` using `budget` and `reason`/)
  await owner('swarm_budget', { budget: { ...f.runtime.mission(f.mission.id).budget, maxTasks: 2 }, reason: 'Room for one more' })
  assert.equal((await worker('swarm_propose', proposal('More after the raise'))).proposedBy, f.author.id, 'the raised limit admits the worker\'s proposal')
  await refused('One more after the raise')
  assert.deepEqual(refusals(), [first, 'mission task budget exhausted (2/2 tasks admitted) (limit 2)'], 'the refusal under the raised limit is a new fact')
})

test('a worker\'s refused proposal is keyed by its reason as well as its limit: a task-budget and an experiment-budget refusal from one proposer at one limit value are two facts', async t => {
  const f = await fixture(t, { budget: { maxTasks: 2, maxExperiments: 2 } })
  f.propose({ title: 'First experiment', experiment: true })
  f.propose({ title: 'Second experiment', experiment: true })
  const proposal = extra => ({ outputs: [], workstreamId: f.stream.id, title: 'More', objective: 'More work', kind: 'research', scope: ['**'], acceptance: MISSION_ACCEPTANCE, checks: [], ...extra })
  assert.throws(() => f.runtime.propose(f.actor(f.author), f.mission.id, proposal()), /task budget exhausted \(2\/2 tasks admitted\) \(limit 2\)/)
  f.runtime.updateBudget(f.owner, f.mission.id, { ...f.runtime.mission(f.mission.id).budget, maxTasks: 5 }, 'Room for tasks, not experiments')
  assert.throws(() => f.runtime.propose(f.actor(f.author), f.mission.id, proposal({ experiment: true })), /experiment budget exhausted \(2\/2 experiments admitted\) \(limit 2\)/)
  const refusals = ownerRows(f, /^\[budget_terminal\]/).filter(delivery => delivery.from === f.author.id).map(delivery => delivery.content.match(/was refused: (.*\(limit \d+\))\)/)[1])
  assert.deepEqual(refusals, ['mission task budget exhausted (2/2 tasks admitted) (limit 2)', 'mission experiment budget exhausted (2/2 experiments admitted) (limit 2)'])
})

test('a notice that names no fact is refused where it is written: NotifyOptions requires a trigger or an explicit key', () => {
  // The refusal is the compiler's: without a trigger or a key, the class alone
  // would name the fact, and every fact of that class on these subjects with it.
  const runtimeSource = join(PROJECT, 'src', 'runtime.ts')
  const source = readFileSync(runtimeSource, 'utf8')
  const edited = source.replace("{ from: member.id, trigger: 'task/verification-deferred', reason }", '{ from: member.id, reason }')
  assert.notEqual(edited, source, 'the fixture edit applies')
  const { options } = ts.getParsedCommandLineOfConfigFile(join(PROJECT, 'tsconfig.json'), { noEmit: true }, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(String(diagnostic.messageText)) } })
  const host = ts.createCompilerHost(options)
  const load = host.getSourceFile.bind(host)
  host.getSourceFile = (file, language, ...rest) => resolve(file) === runtimeSource ? ts.createSourceFile(file, edited, language) : load(file, language, ...rest)
  const program = ts.createProgram({ rootNames: [runtimeSource], options, host })
  const refused = ts.getPreEmitDiagnostics(program, program.getSourceFile(runtimeSource))
    .map(diagnostic => `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`)
  assert.equal(refused.length, 1, refused.join('\n'))
  assert.match(refused[0], /NotifyOptions/)
})
