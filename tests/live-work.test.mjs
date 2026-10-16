import assert from 'node:assert/strict'
import test from 'node:test'
import { projectLiveWork } from '../lib/types/client/live-work.js'
import { PROVIDER_OUTAGE_WINDOW_MS } from '../lib/types/types.js'
import { uiSnapshot } from './fixtures/ui-snapshot.mjs'

function fixture() {
  const snapshot = uiSnapshot(), now = snapshot.mission.updatedAt
  snapshot.tasks[1].epoch = snapshot.tasks[1].attempt.epoch
  snapshot.members[1].activity = { id: 'tool-b', kind: 'tool', tool: 'bash', startedAt: now - 60_000, updatedAt: now - 1000, attemptId: snapshot.tasks[1].attempt.id }
  return { snapshot, now }
}
function project(snapshot, now, extra = {}) { return projectLiveWork(snapshot, { connection: 'connected', now, observedAt: now, ...extra }) }
function nova(value) { return value.rows.find(row => row.member.id === 'b') }
function event(snapshot, seq, type, data, createdAt) { return { seq, missionId: snapshot.mission.id, type, actor: 'b', data, createdAt } }

test('native operation observation drives concurrency, with acceptance counts separate from spend', () => {
  const { snapshot, now } = fixture()
  snapshot.tasks[1].usedSteps = 59; snapshot.tasks[1].maxSteps = 60
  const view = project(snapshot, now)
  assert.equal(view.workingCount, 1)
  assert.equal(nova(view).state, 'observed')
  assert.equal(nova(view).label, 'Running a tool')
  assert.equal(nova(view).operationDurationMs, 60_000)
  assert.equal(nova(view).ageMs, 1000)
  assert.deepEqual(view.counts, { accepted: 1, submitted: 1, pending: 2, running: 1, blocked: 0, cancelled: 0, total: 5 })
  assert.equal('percent' in nova(view), false)
  snapshot.mission.usedTokens += 10_000
  snapshot.mission.updatedAt += 500
  assert.deepEqual(project(snapshot, now), view, 'accounting updates cannot invent work, event identities or completion percentage')
})

test('long tool or model operation stays observed while its host liveness is refreshed', () => {
  const { snapshot, now } = fixture()
  snapshot.members[1].activity.startedAt = now - 3600_000
  snapshot.members[1].activity.kind = 'model'
  assert.equal(nova(project(snapshot, now)).state, 'observed')
  assert.equal(nova(project(snapshot, now)).operationDurationMs, 3600_000)
  snapshot.members[1].activity.updatedAt = now - 30_000
  const quiet = project(snapshot, now)
  assert.equal(nova(quiet).state, 'quiet')
  assert.equal(nova(quiet).animate, false)
  assert.equal(quiet.workingCount, 0)
  assert.equal(nova(quiet).label, 'Waiting for activity confirmation')
  assert.doesNotMatch(JSON.stringify(quiet), /stalled|failed/i)
  assert.equal(nova(project(snapshot, now, { freshnessWindowMs: 60_000 })).state, 'observed')
})

test('transport heartbeat cannot refresh native observation or last meaningful progress', () => {
  const { snapshot, now } = fixture()
  const first = project(snapshot, now)
  const refreshed = project(snapshot, now + 20_000, { observedAt: now + 20_000 })
  assert.equal(refreshed.connection, 'connected')
  assert.equal(nova(refreshed).state, 'quiet')
  assert.equal(nova(refreshed).observedAt, nova(first).observedAt)
  assert.equal(refreshed.lastProgressAt, first.lastProgressAt)
  assert.deepEqual(refreshed.recentEvents, first.recentEvents)
})

test('offline freezes elapsed at the last read and never retains live animation or concurrency', () => {
  const { snapshot, now } = fixture()
  const atDisconnect = project(snapshot, now, { connection: 'reconnecting', observedAt: now })
  const later = project(snapshot, now + 120_000, { connection: 'reconnecting', observedAt: now })
  assert.equal(nova(later).state, 'stale')
  assert.equal(later.workingCount, 0)
  assert.equal(later.lastObservedWorkingCount, 1)
  assert.equal(nova(later).animate, false)
  assert.equal(nova(later).operationDurationMs, nova(atDisconnect).operationDurationMs)
  assert.equal(nova(later).ageMs, nova(atDisconnect).ageMs)
  const unknownRead = project(snapshot, now + 120_000, { connection: 'paused', observedAt: undefined })
  assert.equal(nova(unknownRead).operationDurationMs, 59_000)
})

test('old attempts, wrong owners, inconsistent epochs and absent attempt binding are unconfirmed', () => {
  for (const mutate of [
    snapshot => { snapshot.members[1].activity.attemptId = 'revoked' },
    snapshot => { snapshot.tasks[1].epoch++ },
    snapshot => { snapshot.tasks[1].attempt.ownerId = 'a' },
    snapshot => { delete snapshot.members[1].activity.attemptId },
    snapshot => { delete snapshot.tasks[1].attempt },
    snapshot => { delete snapshot.tasks[1].epoch; delete snapshot.tasks[1].attempt.epoch },
  ]) {
    const { snapshot, now } = fixture(); mutate(snapshot)
    const view = project(snapshot, now)
    assert.equal(view.workingCount, 0)
    assert.equal(nova(view).activity, undefined)
    assert.equal(nova(view).animate, false)
  }
})

test('inactive missions and parked or stopped workers override leftover native activity', () => {
  for (const [status, state] of [['paused', 'paused'], ['stopped', 'stopped'], ['completed', 'complete'], ['blocked', 'waiting'], ['staged', 'waiting']]) {
    const { snapshot, now } = fixture(); snapshot.mission.status = status
    const view = project(snapshot, now)
    assert.equal(view.workingCount, 0)
    assert.equal(view.live, false)
    assert.equal(nova(view).state, state)
    assert.equal(nova(view).activity, undefined)
  }
  const { snapshot, now } = fixture()
  snapshot.members[1].phase = 'parked'
  assert.equal(nova(project(snapshot, now)).state, 'waiting')
  snapshot.members[1].phase = 'stopped'
  assert.equal(nova(project(snapshot, now)).state, 'stopped')
})

test('a provider outage holds a member\'s row only while the runtime reads its route as quiescent: the outage stays recorded until a start opens the session, and a member that works on past the window is observed', () => {
  const { snapshot, now } = fixture()
  // The adapter's in-place retry succeeded; the member runs a tool on its preserved attempt.
  const outage = { class: 'rate-limit', status: 429, message: 'Rate limit reached for requests', at: now }
  const row = at => { snapshot.members[1].providerOutage = { ...outage, at }; const view = project(snapshot, now); return [nova(view).state, nova(view).label, nova(view).activity?.id, view.workingCount] }
  assert.deepEqual(row(now - PROVIDER_OUTAGE_WINDOW_MS), ['waiting', 'Waiting for provider recovery', undefined, 0], 'inside the outage window of the last report the route is quiescent')
  assert.deepEqual(row(now - PROVIDER_OUTAGE_WINDOW_MS - 1), ['observed', 'Running a tool', 'tool-b', 1], 'one millisecond past it the route is live, as re-routing and start pacing read it')
  assert.deepEqual(row(now - 3_600_000), ['observed', 'Running a tool', 'tool-b', 1], 'an outage recorded an hour ago does not hide the member\'s work')
})

test('retry is waiting and verification includes its preparation phase without claiming test execution', () => {
  const { snapshot, now } = fixture()
  snapshot.members[1].activity.kind = 'retry'
  assert.equal(nova(project(snapshot, now)).state, 'waiting')
  assert.equal(project(snapshot, now).workingCount, 0)
  snapshot.members[1].activity.kind = 'verification'
  assert.equal(nova(project(snapshot, now)).label, 'Verification in progress')
  snapshot.tasks[1].attempt.leaseUntil = now - 1
  assert.equal(nova(project(snapshot, now)).state, 'quiet')
})

test('real transitions and tool results have durable deduplicated bounded event identities across reload', () => {
  const { snapshot, now } = fixture()
  const native = event(snapshot, 6, 'member/activity', { memberId: 'b', activity: snapshot.members[1].activity }, now - 3000)
  const recorded = event(snapshot, 7, 'tool/recorded', { runId: 'run-1', taskId: 't2', tool: 'bash', isError: false }, now - 2000)
  snapshot.events.push(native, recorded, structuredClone(native), structuredClone(recorded),
    event(snapshot, 8, 'member/heartbeat', { memberId: 'b' }, now - 1000),
    event(snapshot, 9, 'member/activity', { memberId: 'b', activity: { ...snapshot.members[1].activity, attemptId: 'revoked' } }, now - 500),
    { ...recorded, missionId: 'another-mission', seq: 10 })
  const view = project(snapshot, now, { eventLimit: 3 })
  assert.deepEqual(view.recentEvents.map(item => item.id), ['mission-demo:7', 'mission-demo:6', 'mission-demo:4'])
  assert.equal(view.recentEvents[0].label, 'Tool result recorded')
  assert.equal(view.lastProgressAt, now - 2000)
  assert.deepEqual(project(structuredClone(snapshot), now, { eventLimit: 3 }).recentEvents, view.recentEvents)
  snapshot.members[1].activity.updatedAt = now
  assert.deepEqual(project(snapshot, now, { eventLimit: 3 }).recentEvents, view.recentEvents, 'liveness touches do not make new activity rows')
  assert.equal(project(snapshot, now, { eventLimit: 0 }).recentEvents.length, 0)
})

test('missing or malformed observations degrade safely and clock skew cannot produce negative durations', () => {
  for (const activity of [undefined, {}, { id: 'bad', kind: 'model', startedAt: NaN, updatedAt: 1 }, { id: 'bad', kind: 'model', startedAt: 20, updatedAt: 10 }]) {
    const { snapshot, now } = fixture(); snapshot.members[1].activity = activity
    assert.equal(nova(project(snapshot, now)).state, 'quiet')
  }
  const { snapshot, now } = fixture()
  snapshot.members[1].activity.startedAt = now + 1000
  snapshot.members[1].activity.updatedAt = now + 1000
  assert.equal(nova(project(snapshot, now)).operationDurationMs, 0)
  assert.equal(nova(project(snapshot, now)).ageMs, 0)
})
