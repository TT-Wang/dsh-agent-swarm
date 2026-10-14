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
import { FakeClock, PROJECT, events, setup } from './faults/harness.mjs'

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

test('a provider outage is its class on the member\'s open work: a retry, a report after a pass restarted the resident member and a return to a class already told are that fact; another class, or the class over new work, is a new one', async t => {
  const f = await fixture(t)
  const first = f.propose({ title: 'Running work' })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, first.id)
  const outages = () => ownerRows(f, /^Author provider/).map(delivery => [delivery.content.match(/provider (\S+) outage/)[1], delivery.subjects])
  const subject = task => [`${task.id}@${f.runtime.store.get('tasks', task.id).epoch}`]
  const report = (outage, status, message) => f.workers.callbacks.providerOutage(f.author.id, { class: outage, status, message })
  // What the adapter reports while it retries the preserved attempt in place, a scheduling pass between reports: each pass restarts the resident member.
  for (let pass = 0; pass < 3; pass++) {
    report('rate-limit', 429, 'Rate limit reached for requests')
    f.clock.advance(1_000)
    f.runtime.kick(f.mission.id)
    await f.runtime.settle(f.mission.id)
  }
  assert.ok(events(f.runtime, f.mission.id, 'provider/recovered').length >= 2, 'the passes restarted the member between reports')
  assert.equal(f.runtime.store.get('tasks', first.id).attempt?.id, claimed.attempt.id, 'on the same preserved attempt')
  assert.deepEqual(outages(), [['rate-limit', subject(first)]], 'a report after a pass is the fact the owner holds')
  report('unavailable', 503, 'upstream down')
  report('rate-limit', 429, 'Rate limit reached for requests')
  assert.deepEqual(outages(), [['rate-limit', subject(first)], ['unavailable', subject(first)]], 'another class is told; a return to a class told on this work is not')
  // The member moves to new work with no pass between, still rate-limited.
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: first.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const second = f.propose({ title: 'Next work' })
  await f.runtime.claim(f.actor(f.author), f.mission.id, second.id)
  f.clock.advance(31_000)
  report('rate-limit', 429, 'Rate limit reached for requests')
  assert.deepEqual(outages(), [['rate-limit', subject(first)], ['unavailable', subject(first)], ['rate-limit', subject(second)]], 'the class over new work is a new fact')
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

test('a member failure is keyed by its recorded message: another failure on the same work is told, a repeat is not', async t => {
  const f = await fixture(t)
  f.workers.callbacks.failure(f.author.id, 'session crashed')
  f.workers.callbacks.failure(f.author.id, 'session crashed')
  f.workers.callbacks.failure(f.author.id, 'provider returned malformed output')
  assert.deepEqual(ownerRows(f, /^Author failed: /).map(delivery => delivery.content), ['Author failed: session crashed', 'Author failed: provider returned malformed output'])
})

test('a worker\'s refused proposal is one fact per reason and limit: a repeat is not told again, a raised limit is', async t => {
  const f = await fixture(t, { budget: { maxTasks: 1 } })
  f.propose({ title: 'Admitted' })
  const proposeAsAuthor = title => assert.throws(() => f.runtime.propose(f.actor(f.author), f.mission.id, {
    outputs: [], workstreamId: f.stream.id, title, objective: 'More work', kind: 'research', scope: ['**'], acceptance: ['works'], checks: [] }), /task budget exhausted/)
  const refusals = () => ownerRows(f, /^\[budget_terminal\]/).filter(delivery => delivery.from === f.author.id).map(delivery => delivery.content.match(/was refused: (.*\(limit \d+\))\)/)[1])
  proposeAsAuthor('More')
  proposeAsAuthor('More again')
  assert.deepEqual(refusals(), ['mission task budget exhausted (1/1 tasks admitted) (limit 1)'], 'the same refusal is told once')
  f.runtime.updateBudget(f.owner, f.mission.id, { ...f.runtime.mission(f.mission.id).budget, maxTasks: 2 }, 'room for one more')
  f.propose({ title: 'Admitted after the raise' })
  proposeAsAuthor('More after the raise')
  assert.deepEqual(refusals(), ['mission task budget exhausted (1/1 tasks admitted) (limit 1)', 'mission task budget exhausted (2/2 tasks admitted) (limit 2)'], 'the raised limit is a new fact')
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
