import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { uiSnapshot } from './fixtures/ui-snapshot.mjs'
import { currentProgress, recentProgress, acceptanceSummary, activityDuration } from '../lib/types/client/progress.js'
import { MissionProgress } from '../lib/types/client/MissionProgress.js'
import { SwarmBoard } from '../lib/types/client/SwarmBoard.js'
import { ActivityPanel } from '../lib/types/client/ActivityPanel.js'
import { DeliveryPanel } from '../lib/types/client/DeliveryPanel.js'
import { CopyContext, zh } from '../lib/types/client/locale.js'

function render(component, props, chinese = false) {
  const element = React.createElement(component, props)
  return renderToStaticMarkup(chinese ? React.createElement(CopyContext.Provider, { value: text => zh[text] ?? text }, element) : element)
}
function withActivity(kind = 'model') {
  const snapshot = uiSnapshot()
  snapshot.members[1].activity = { id: 'native-operation', kind, startedAt: snapshot.mission.updatedAt - 5000, updatedAt: snapshot.mission.updatedAt - 2000, attemptId: snapshot.tasks[1].attempt.id }
  return snapshot
}
function panelProps(state) {
  const sessionState = { current: 'owner', byId: { owner: { id: 'owner', displayTitle: 'Owner conversation' } } }
  const subscribe = () => () => {}
  return {
    sessions: { list: { getSnapshot: () => sessionState, subscribe } },
    modelDirectories: { directoryFor: () => undefined },
    monitor: { getSnapshot: () => state, subscribe, request: async () => { throw new Error('Rendering cannot request data') } },
    history: { getSnapshot: () => ({}), subscribe }, onOpenWorker() {},
  }
}

test('current activity uses observed native lifecycle, rejects revoked attempts and never turns accounting into progress', () => {
  const snapshot = withActivity()
  const thinking = currentProgress(snapshot)
  assert.equal(thinking.label, 'Agent is thinking')
  assert.equal(thinking.member.id, 'b')
  assert.equal(thinking.task.id, 't2')
  assert.equal(thinking.observedAt, snapshot.members[1].activity.updatedAt)
  const oldObserved = thinking.observedAt
  snapshot.mission.updatedAt += 60_000
  snapshot.mission.usedTokens += 1000
  assert.equal(currentProgress(snapshot).observedAt, oldObserved, 'refresh/accounting cannot pretend a new work event happened')
  snapshot.members[1].activity.attemptId = 'revoked-attempt'
  assert.equal(currentProgress(snapshot).label, 'Task in progress')
  delete snapshot.members[1].activity
  assert.equal(currentProgress(snapshot).label, 'Task in progress', 'working member status alone does not mean its model is currently thinking')
})

test('retry, verification and transport state are separate from task lifecycle', () => {
  const snapshot = withActivity('retry')
  snapshot.members[1].activity.retryAt = snapshot.mission.updatedAt + 10_000
  snapshot.members[1].activity.retryAttempt = 2
  assert.equal(currentProgress(snapshot).label, 'Waiting to retry')
  const offline = currentProgress(snapshot, 'reconnecting')
  assert.equal(offline.stale, true)
  assert.equal(offline.label, 'Waiting to retry', 'transport failure must not declare task failure')
  const markup = render(MissionProgress, { snapshot, live: true, connection: 'reconnecting' })
  assert.match(markup, /Last observed state/)
  assert.match(markup, /Current execution is unconfirmed/)
  assert.match(markup, /Retry scheduled for/)
  snapshot.members[1].activity.kind = 'verification'
  assert.equal(currentProgress(snapshot).label, 'Running verification')
  snapshot.mission.status = 'paused'
  assert.equal(currentProgress(snapshot).label, 'Mission paused', 'terminal/control state overrides old activities')
})

test('activity focus is stable across token updates and prioritizes real verification over model thinking', () => {
  const snapshot = withActivity('tool'), at = snapshot.mission.updatedAt
  snapshot.members[0].activity = { id: 'model-a', kind: 'model', startedAt: at, updatedAt: at + 50_000 }
  assert.equal(currentProgress(snapshot).member.id, 'b', 'later token chunks cannot displace an active tool')
  snapshot.members[2].activity = { id: 'verify-c', kind: 'verification', startedAt: at - 100_000, updatedAt: at - 100_000 }
  assert.equal(currentProgress(snapshot).member.id, 'c', 'verification remains foremost until it ends')
  delete snapshot.members[2].activity
  snapshot.members[1].activity.kind = 'model'
  assert.equal(currentProgress(snapshot).member.id, 'a', 'same-kind focus follows stable operation start time')
  snapshot.members[1].activity.updatedAt = at + 1_000_000
  assert.equal(currentProgress(snapshot).member.id, 'a', 'updatedAt does not reorder the focus')
})

test('historical duration uses the recorded native interval and formatting clamps clock skew', () => {
  assert.deepEqual(activityDuration(1000, 66_900), { minutes: 1, seconds: 5 })
  assert.deepEqual(activityDuration(5000, 2000), { minutes: 0, seconds: 0 })
  const snapshot = withActivity()
  const historical = render(MissionProgress, { snapshot, live: false })
  assert.match(historical, /Elapsed <!-- -->3sec|Elapsed 3sec/)
  assert.match(historical, /Recorded state/)
  const offline = render(MissionProgress, { snapshot, live: true, connection: 'reconnecting' })
  assert.match(offline, /Elapsed <!-- -->3sec|Elapsed 3sec/)
})

test('recent progress has at most three meaningful events with real task titles, excluding chat and heartbeat noise', () => {
  const snapshot = uiSnapshot(), at = snapshot.mission.updatedAt
  snapshot.events.push(
    { seq: 5, type: 'task/submitted', data: { taskId: 't2', rawArguments: 'must never appear' }, createdAt: at },
    { seq: 6, type: 'task/accepted', data: { sourceTaskId: 't2' }, createdAt: at + 1 },
    { seq: 7, type: 'tool/recorded', data: { tool: 'bash' }, createdAt: at + 2 },
    { seq: 8, type: 'member/heartbeat', data: {}, createdAt: at + 3 },
    { seq: 9, type: 'message/queued', data: { text: 'noise' }, createdAt: at + 4 },
  )
  const events = recentProgress(snapshot)
  assert.deepEqual(events.map(event => event.seq), [6, 5, 4])
  assert.equal(events[0].detail, snapshot.tasks[1].title)
  assert.equal(events[0].label, 'Work accepted')
  assert.doesNotMatch(JSON.stringify(events), /rawArguments|must never appear|heartbeat|noise/)
})

test('default historical card is compact and technical views are opt-in', () => {
  const snapshot = withActivity()
  const markup = render(SwarmBoard, { snapshot, onOpenWorker() {} })
  assert.match(markup, /Recorded state/)
  assert.match(markup, /data-swarm-details="team"/)
  assert.match(markup, /data-swarm-details="technical"/)
  assert.match(markup, /data-swarm-accepted="">1 \/ 5 tasks accepted/)
  assert.doesNotMatch(markup, /role="tab"|class="sw-metrics"|class="sw-board"/)
  assert.equal((markup.match(/data-swarm-progress-event=/g) ?? []).length, 3)
  const expanded = render(SwarmBoard, { snapshot, initialView: 'graph' })
  assert.match(expanded, /data-swarm-details="technical" open=""/)
  assert.match(expanded, /role="tabpanel" aria-label="Dependency graph"/)
  const chinese = render(SwarmBoard, { snapshot }, true)
  assert.match(chinese, /智能体正在思考/)
  assert.match(chinese, /任务与资源详情/)
  assert.match(chinese, /项已验收/)
})

test('completed summary presents accepted output and actual review counts, never an unaccepted claim', () => {
  const snapshot = uiSnapshot()
  snapshot.mission.status = 'completed'
  snapshot.tasks[0].output = 'Accepted research output'
  snapshot.tasks[1].output = 'Unaccepted implementation claim'
  snapshot.tasks[2].status = 'accepted'
  const counts = acceptanceSummary(snapshot)
  assert.equal(counts.reviews, 1)
  assert.deepEqual(counts.outputs.map(task => task.id), ['t1'])
  const markup = render(SwarmBoard, { snapshot })
  assert.match(markup, /Accepted research output/)
  assert.match(markup, /1 independent reviews accepted/)
  assert.doesNotMatch(markup, /Unaccepted implementation claim/)
})

test('new mission defaults to natural language guidance and connecting state is never shown as connected', () => {
  const data = { ownerSessionId: 'owner', workspace: '/repo', snapshots: [], drafts: [], starts: [], writable: true, ownerLive: true, defaultBudget: uiSnapshot().mission.budget }
  const empty = render(ActivityPanel, panelProps({ ownerSessionId: 'owner', data, loading: false, connection: 'connected' }))
  assert.match(empty, /data-swarm-natural-start=""/)
  assert.match(empty, /\/agent-swarm Describe what you want to accomplish/)
  assert.match(empty, /data-swarm-details="editor"/)
  assert.doesNotMatch(empty, /draft-title|type="number"|class="sw-editor"/)
  assert.doesNotMatch(empty, /<select/)
  const oneMission = render(ActivityPanel, panelProps({ ownerSessionId: 'owner', data: { ...data, snapshots: [uiSnapshot()] }, loading: false, connection: 'connected' }))
  assert.doesNotMatch(oneMission, /<select/, 'a single current mission does not repeat its title in a picker')
  const second = uiSnapshot(); second.mission.id = 'second-mission'
  const multiple = render(ActivityPanel, panelProps({ ownerSessionId: 'owner', data: { ...data, snapshots: [uiSnapshot(), second] }, loading: false, connection: 'connected' }))
  assert.match(multiple, /<select aria-label="Missions"/, 'multiple missions remain selectable')
  const connecting = render(ActivityPanel, panelProps({ ownerSessionId: 'owner', loading: true, connection: 'connecting' }))
  assert.match(connecting, /data-swarm-connection="connecting"/)
  assert.doesNotMatch(connecting, />Connected</)
  const otherOwner = render(ActivityPanel, panelProps({ ownerSessionId: 'different-owner', data: { ...data, snapshots: [uiSnapshot()] }, loading: false, connection: 'connected', error: 'other owner error' }))
  assert.doesNotMatch(otherOwner, /Build a reliable agent swarm|other owner error/)
})

test('a persisted delivery receipt keeps the completed result marked applied after remount', () => {
  const snapshot = uiSnapshot()
  snapshot.tasks[0].kind = 'integration'
  snapshot.tasks[0].artifact = snapshot.tasks[3].artifact
  snapshot.events.push({ seq: 100, type: 'delivery/applied', createdAt: snapshot.mission.updatedAt, data: { resultCommit: snapshot.tasks[0].artifact.commit } })
  const markup = render(DeliveryPanel, { snapshot, sessionId: 'owner', request: async () => {}, onApplied() {} })
  assert.match(markup, /data-action="apply-delivery"[^>]*disabled=""[^>]*>Applied</)
  assert.match(markup, /View changes/)
  assert.match(markup, /Result applied to working files/)
})
