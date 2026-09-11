/**
 * R17-G6/G7 — one truth for mission derived state (branch B1).
 *
 * Two claims, each pinned by a test that fails on the pre-change tree:
 *
 * 1. **The plugin writes nothing into the owner session log.** Round 17 also
 *    registered a host projection unit and published each derived board as a
 *    plugin-owned session event (`swarm/mission`). The host's session format
 *    keeps a closed vocabulary with no plugin registration path and refuses to
 *    decode a stored log containing an unknown type unless its envelope carries
 *    `ignorable: true` — which `Session.append()` cannot set — so a written log
 *    could not be read back by its own writer and the real-host tiers refused
 *    with `SessionFormatUnsupportedError`. The publication and the registration
 *    are deleted; this file pins that the log stays empty and that no source
 *    appends a session event.
 * 2. **Member state is a durable phase plus a derived live status.** The durable
 *    row carries `phase` and never `status`; `SwarmStore` drops any status on
 *    write and re-derives it on read from the phase and the running attempts, so
 *    the R15-F2 seam (a row reading `idle` while a live attempt exists) cannot be
 *    constructed, and the reconcile path is gone from the source.
 * 3. **The one derivation is the read face.** `SwarmRuntime.memberBoard` is what
 *    the guard board and the owner/UI views (`snapshot`, `observe`) consume, and
 *    it is the single derivation applied to durable rows — a mounted projection
 *    registry that serves a different board cannot change it.
 * 4. **A phase-less legacy row keeps its recorded intent.** The live store's
 *    shape (142 rows, no phase, 114 `stopped`) is seeded raw and every stopped
 *    row stays stopped and non-dispatchable; the rule is
 *    `src/projection.ts#memberPhaseOf` and its one unrecovered case (a legacy
 *    `working` row with no attempt reads idle) is recorded in
 *    `docs/known-limitations.md`.
 *
 * Every guard this branch alters names the guards it can co-fire with and ships
 * a pair test: the board guard (`guardBoard` -> `guardProgressActions`), the
 * dispatch decision (the parked-member hatch vs the adapter's busy handle), the
 * W6 idle close-out, and the UI projection (`runtime.snapshot`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { SwarmRuntime } from '../lib/runtime.js'
import { SwarmStore } from '../lib/store.js'
import { Scheduling, guardActions, guardProgressActions } from '../lib/scheduling.js'
import { tempDirectory } from './temp-root.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
/** The pre-change tree has no built projection module; every test says so explicitly. */
const projection = await import('../lib/projection.js').then(module => module, () => undefined)
const MISSING = 'src/projection.ts is not built: the mission projection / member-status split is absent'

const OWNER = 'r17-owner'
const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 20, maxExperiments: 2 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function eventually(fn, message, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out: ${message}`)
    await sleep(10)
  }
}

class Workers {
  constructor(ctx, options = {}) { this.ctx = ctx; this.options = options; this.started = []; this.stopped = [] }
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(_mission, id) { return `/isolated/${id}` }
  async start(spec) { this.started.push(spec.member.id) }
  async deliver() {}
  async stop(memberId) { this.stopped.push(memberId) }
  isIdle(memberId) { return this.options.idle === undefined ? true : this.options.idle(memberId) }
  async captureArtifact() { return { commit: 'c', baseCommit: 'b', workspace: '/isolated', changedPaths: [] } }
  async verifyArtifact() { return [] }
  async prepareTask() {}
  async dispose() {}
}

async function fixture(t, { workers: provided, registry } = {}) {
  const dir = await tempDirectory('swarm-r17-projection-')
  const ctx = new Context()
  // A provided registry is the test's own host unit: the consumers must read it.
  if (registry === undefined) await ctx.plugin(SessionProjectionRegistry)
  else ctx.provide('sessionProjections', registry)
  const session = Session.create(SessionId(OWNER))
  ctx.provide('sessions', { get: id => String(id) === OWNER ? session : undefined })
  const workers = provided ?? new Workers(ctx)
  const runtime = new SwarmRuntime({ statePath: join(dir, 'db.sqlite'), leaseMs: 60000, tickMs: 25, maxMessageChars: 16000, maxEvents: 500, maxTasksPerMember: 9 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) })
  await runtime.start()
  const owner = { sessionId: OWNER }
  const mission = runtime.create(owner, { title: 'One truth', objective: 'One derivation', workspace: dir, scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const addMember = name => runtime.addMember(owner, mission.id, { name, role: 'implementation' })
  const propose = (title, input = {}) => runtime.propose(owner, mission.id, { workstreamId: stream.id, title, objective: title, kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['true'], ...input })
  const claim = (member, task) => runtime.claim({ sessionId: member.sessionId }, mission.id, task.id)
  const memberRow = member => runtime.store.get('members', member.id)
  const taskRow = task => runtime.store.get('tasks', task.id)
  const storedMember = member => {
    const db = new DatabaseSync(join(dir, 'db.sqlite'), { readOnly: true })
    try {
      const row = db.prepare('SELECT value FROM members WHERE id=?').get(member.id)
      return JSON.parse(String(row.value))
    } finally { db.close() }
  }
  return { dir, ctx, session, runtime, workers, owner, mission, stream, addMember, propose, claim, memberRow, taskRow, storedMember }
}

test('no session event: the plugin appends nothing to the owner log, and the derivation is the read face', async t => {
  assert.ok(projection, MISSING)
  const f = await fixture(t)
  const member = await f.addMember('Ada')
  assert.deepEqual(f.session.snapshotEvents().map(event => event.type).filter(type => !KNOWN_SESSION_EVENT_TYPES.has(type)), [], 'no event outside the host vocabulary is written into the session log')

  const task = f.propose('Claim me')
  await f.claim(member, task)
  const working = await eventually(() => {
    const row = f.runtime.memberBoard(f.mission.id).find(candidate => candidate.id === member.id)
    return row?.status === 'working' ? row : undefined
  }, 'the live attempt is visible through the derivation')
  assert.equal(working.phase, 'active')
  assert.deepEqual(f.session.snapshotEvents().map(event => event.type).filter(type => !KNOWN_SESSION_EVENT_TYPES.has(type)), [], 'a live transition writes no plugin-owned type either')

  // The class of failure this replaced: a stored log is refused when it carries
  // an event type the host's closed vocabulary does not know and the envelope is
  // not marked ignorable. The only durable answer is to append nothing, so the
  // check is source-level and exhaustive over every writer in src/.
  const { readdir } = await import('node:fs/promises')
  const sources = await Promise.all((await readdir(join(ROOT, 'src'))).filter(name => name.endsWith('.ts'))
    .map(async name => [name, await readFile(join(ROOT, 'src', name), 'utf8')]))
  const appenders = sources.filter(([, source]) => /session\.append\(|\.append\(\s*['"]swarm\//.test(source)).map(([name]) => name)
  assert.deepEqual(appenders, [], 'no src module appends a session event: the host format cannot carry a plugin-owned type')
})

test('the durable member row carries a phase and never a status; the read face derives it', async t => {
  assert.ok(projection, MISSING)
  const f = await fixture(t)
  const member = await f.addMember('Ada')
  const stored = f.storedMember(member)
  assert.equal(stored.phase, 'active', 'the durable phase is what the store persists')
  assert.equal(Object.hasOwn(stored, 'status'), false, 'no stored field mirrors the live status')
  assert.equal(f.memberRow(member).status, 'idle', 'the read face derives the status')

  // A caller that assigns the derived field changes nothing durable, so the next
  // read cannot be poisoned by a stale write (the R15-F2 shape).
  f.runtime.store.transaction(() => { const row = f.runtime.store.get('members', member.id); row.status = 'working'; f.runtime.store.put('members', row) })
  assert.equal(Object.hasOwn(f.storedMember(member), 'status'), false)
  assert.equal(f.memberRow(member).status, 'idle')

  assert.equal(projection.deriveMemberStatus('active', true), 'working')
  assert.equal(projection.deriveMemberStatus('active', false), 'idle')
  assert.equal(projection.deriveMemberStatus('parked', true), 'waiting', 'the durable park wins over work in flight')
  assert.equal(projection.deriveMemberStatus('stopped', true), 'stopped')
})

test('R15-F2 is impossible by construction: a live attempt can never read idle', async t => {
  assert.ok(projection, MISSING)
  const f = await fixture(t)
  const member = await f.addMember('Ada')
  const task = f.propose('Live attempt')
  await f.claim(member, task)
  assert.equal(f.taskRow(task).status, 'running')
  assert.equal(f.memberRow(member).status, 'working', 'the row cannot lag the attempt it owns')
  assert.equal(Object.hasOwn(f.storedMember(member), 'status'), false)

  // The seam's exact shape: someone writes `idle` onto the member row while the
  // attempt is running. The write is not durable and the read is derived.
  f.runtime.store.transaction(() => { const row = f.runtime.store.get('members', member.id); row.status = 'idle'; f.runtime.store.put('members', row) })
  assert.equal(f.memberRow(member).status, 'working')
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).members.find(row => row.id === member.id).status, 'working')

  const source = await readFile(join(ROOT, 'src/runtime.ts'), 'utf8')
  assert.equal(/reconcileMemberStatus\s*\(/.test(source), false, 'the reconcile path is deleted, not repaired')
})

test('pair: the board guard and the dispatch decision read the one derivation', async t => {
  assert.ok(projection, MISSING)
  // The adapter's handle reports busy, so only the durable park can make this
  // member dispatchable (the parked-member hatch).
  let busy = true
  const f = await fixture(t, { workers: new Workers(undefined, { idle: () => !busy }) })
  const member = await f.addMember('Ada')
  const task = f.propose('Dispatch me')
  f.runtime.wait({ sessionId: member.sessionId }, f.mission.id)
  assert.equal(f.memberRow(member).status, 'waiting', 'the durable phase derives `waiting`')
  assert.equal(f.memberRow(member).phase, 'parked')

  // Dispatch decision x parked-member hatch: the busy handle does not strand it.
  const dispatched = await eventually(() => f.taskRow(task).status === 'running' ? f.taskRow(task) : undefined, 'a parked member is dispatched despite a busy handle')
  assert.equal(dispatched.attempt.ownerId, member.id)

  // While the durable park stands, the park wins over the attempt (the hatch and
  // the guard board agree): a parked owner still holds its work.
  const scheduling = new Scheduling(f.runtime)
  assert.equal(scheduling.guardBoard(f.mission.id).members.find(row => row.id === member.id).status, 'waiting')

  // The assignment is the fresh input that unparks the member; the status then
  // follows the live attempt through the same derivation.
  await f.workers.callbacks.beforeStep(member.id, true)
  assert.equal(f.memberRow(member).phase, 'active')
  assert.equal(f.memberRow(member).status, 'working')
  const board = scheduling.guardBoard(f.mission.id)
  assert.equal(board.members.find(row => row.id === member.id).status, 'working')
  assert.ok(guardProgressActions(board).some(action => action.kind === 'progress' && action.memberId === member.id), 'the guard board sees the live attempt as progress')
  assert.ok(guardActions(board).some(action => action.kind === 'progress' && action.memberId === member.id))
  busy = false
})

test('pair: the W6 idle close-out owns the attempt and the derived status agrees while it does', async t => {
  assert.ok(projection, MISSING)
  const f = await fixture(t)
  const member = await f.addMember('Ada')
  const task = f.propose('Idle turn')
  await f.claim(member, task)
  await f.workers.callbacks.idle(member.id)
  // The adapter ended its turn; the attempt is still live until the close-out
  // fences it, so the member is still working — the derivation agrees with the
  // close-out instead of racing it.
  assert.ok(f.taskRow(task).idleSignal, 'the durable idle signal is recorded')
  assert.equal(f.memberRow(member).status, 'working')
  assert.equal(f.storedMember(member).status ?? null, null, 'the close-out window writes no durable status either')
  // The close-out fences that attempt (nudge, then checkpoint + re-pend) with no
  // status write anywhere; whichever way it ends, the derived status is exactly
  // the surviving attempt's state.
  const fenced = await eventually(() => {
    const row = f.taskRow(task)
    return row.attempt?.id === undefined || row.attempt.id !== f.runtime.store.get('tasks', task.id).id ? true : undefined
  }, 'the close-out re-pends the attempt')
  assert.ok(fenced)
  const status = f.memberRow(member).status
  assert.ok(status === 'working' || status === 'idle', 'the derived status follows the surviving attempt')
  // With no attempt left (the successor is withdrawn), the same derivation is
  // `idle` — no writer has to say so.
  await f.runtime.cancel(f.owner, f.mission.id, { taskId: task.id, reason: 'close-out pair: fence the successor' })
  assert.equal(f.memberRow(member).status, 'idle')
})

test('pair: the UI projection carries the derived status', async t => {
  assert.ok(projection, MISSING)
  const f = await fixture(t)
  const member = await f.addMember('Ada')
  const task = f.propose('Visible work')
  await f.claim(member, task)
  const snapshot = f.runtime.snapshot(f.owner, f.mission.id)
  assert.equal(snapshot.members.find(row => row.id === member.id).status, 'working', 'the snapshot is the client read face')
  const observed = f.runtime.observe(f.owner, f.mission.id)
  assert.equal(observed.members.find(row => row.id === member.id).status, 'working', 'the compact board the client renders carries the derived status')
})

test('a mounted projection registry cannot change the read face: the derivation is the only source', async t => {
  assert.ok(projection, MISSING)
  // A hostile unit: it answers every read with a wrong board and counts
  // registrations. Nothing in the product may consult it.
  let registrations = 0
  const wrong = { missions: {} }
  const registry = {
    register: () => { registrations += 1; return () => {} },
    stateOf: () => ({ version: 1, sessionId: OWNER, missions: wrong.missions }),
  }
  const f = await fixture(t, { registry })
  const member = await f.addMember('Ada')
  assert.equal(f.runtime.memberBoard(f.mission.id).find(row => row.id === member.id).status, 'idle', 'the derivation says idle')

  // The hostile unit claims the member is parked. No consumer may believe it.
  wrong.missions[f.mission.id] = { missionId: f.mission.id, status: 'active', updatedAt: 0, members: [{ id: member.id, phase: 'parked', status: 'waiting' }] }
  assert.equal(f.runtime.memberBoard(f.mission.id).find(row => row.id === member.id).status, 'idle', 'memberBoard ignores the registry')
  assert.equal(new Scheduling(f.runtime).guardBoard(f.mission.id).members.find(row => row.id === member.id).status, 'idle', 'the guard board ignores the registry')
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).members.find(row => row.id === member.id).status, 'idle', 'the snapshot (client read face) ignores the registry')
  assert.equal(f.runtime.observe(f.owner, f.mission.id).members.find(row => row.id === member.id).status, 'idle', 'the observe board ignores the registry')
  assert.equal(registrations, 0, 'the plugin registers no projection unit')
})

test('a phase-less legacy member row keeps its recorded intent: the live-store shape stays stopped', async t => {
  assert.ok(projection, MISSING)
  const dir = await tempDirectory('swarm-r17-legacy-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const statePath = join(dir, 'db.sqlite')
  const MISSION = 'mission_legacy'
  // 1. Create the schema, record the mission the members belong to, then write
  //    the live store's exact member shape: 142 rows, no phase, 114 `stopped`.
  const seed = new SwarmStore(statePath)
  seed.transaction(() => seed.put('missions', {
    id: MISSION, missionId: MISSION, title: 'Legacy', objective: 'Keep the recorded intent', workspace: '/legacy',
    status: 'paused', scope: ['src/'], acceptance: ['works'], budget, ownerSessionId: 'legacy-owner',
    usedTokens: 0, usedSteps: 0, createdAt: Date.now(), updatedAt: Date.now(), deadline: Date.now() + 3_600_000,
  }))
  seed.close()
  const db = new DatabaseSync(statePath)
  try {
    const insert = db.prepare('INSERT INTO members(id, mission_id, value) VALUES(?,?,?)')
    for (let index = 0; index < 142; index += 1) {
      const status = index < 114 ? 'stopped' : index < 138 ? 'idle' : 'working'
      const member = { id: `legacy_${index}`, missionId: MISSION, name: `M${index}`, role: 'implementation', sessionId: `legacy_session_${index}`, workspace: '/isolated', status, subscriptions: [] }
      insert.run(member.id, MISSION, JSON.stringify(member))
    }
  } finally { db.close() }

  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  ctx.provide('sessions', { get: () => undefined })
  const runtime = new SwarmRuntime({ statePath, leaseMs: 60000, tickMs: 10_000, maxMessageChars: 16000, maxEvents: 500, maxTasksPerMember: 9 }, new Workers(ctx))
  t.after(async () => { await runtime.dispose() })
  await runtime.start()

  const rows = runtime.store.list('members', MISSION)
  assert.equal(rows.length, 142, 'the seeded live-store shape is read whole')
  const stopped = rows.filter(row => row.phase === 'stopped')
  assert.equal(stopped.length, 114, 'every phase-less `stopped` row keeps the durable intent')
  assert.ok(stopped.every(row => row.status === 'stopped'))
  assert.equal(rows.filter(row => row.phase === 'active').length, 28)
  // The 4 legacy `working` rows own no attempt: `working` was a live fact, not
  // intent, so the derived truth is idle (documented in docs/known-limitations.md).
  assert.ok(rows.slice(138).every(row => row.phase === 'active' && row.status === 'idle'))
  // The reviewer's exact reproduction: the stopped member is not a participant
  // and cannot be dispatched.
  assert.throws(() => runtime.participant({ sessionId: 'legacy_session_0' }, MISSION), /not a participant/, 'a stopped legacy member stays out of the mission')
  assert.equal(new Scheduling(runtime).guardBoard(MISSION).members.filter(row => row.status === 'stopped').length, 114, 'the guard model sees all 114 stopped')
  // The rule itself, including the parked intent.
  assert.equal(projection.memberPhaseOf({ status: 'stopped' }), 'stopped')
  assert.equal(projection.memberPhaseOf({ status: 'waiting' }), 'parked')
  assert.equal(projection.memberPhaseOf({ status: 'working' }), 'active')
  assert.equal(projection.memberPhaseOf({ phase: 'parked', status: 'stopped' }), 'parked', 'an explicit phase always wins over the legacy field')
})

test('the scoped writers are gone and nothing writes a session event', async t => {
  assert.ok(projection, MISSING)
  const strip = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const runtimeSource = strip(await readFile(join(ROOT, 'src/runtime.ts'), 'utf8'))
  const schedulingSource = strip(await readFile(join(ROOT, 'src/scheduling.ts'), 'utf8'))
  for (const [file, source] of [['src/runtime.ts', runtimeSource], ['src/scheduling.ts', schedulingSource]]) {
    assert.equal(/reconcileMemberStatus\s*\(/.test(source), false, `${file} still calls the reconcile path`)
    assert.equal(/member\.status\s*=(?!=)/.test(source), false, `${file} still writes the derived member status`)
    assert.equal(/\.status\s*=\s*'waiting'/.test(source), false, `${file} still writes a live waiting status`)
    assert.equal(/\.status\s*=\s*'working'/.test(source), false, `${file} still writes a live working status`)
  }
  const projectionSource = await readFile(join(ROOT, 'src/projection.ts'), 'utf8')
  assert.equal(/sessionProjections/.test(projectionSource), false, 'the deleted host unit is not referenced again')
  assert.equal(/session\.append\(/.test(projectionSource), false, 'the projection appends no session event')
  assert.equal(/MissionProjection\b/.test(strip(await readFile(join(ROOT, 'src/runtime.ts'), 'utf8'))), false, 'the runtime holds no projection owner')
  assert.match(strip(await readFile(join(ROOT, 'src/types.ts'), 'utf8')), /export type MemberPhase = /, 'the durable phase is declared')
})
