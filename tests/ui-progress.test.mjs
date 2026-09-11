import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { uiSnapshot } from './fixtures/ui-snapshot.mjs'
import { currentProgress, recentProgress, acceptanceSummary, activityDuration } from '../lib/types/client/progress.js'
import { MissionProgress } from '../lib/types/client/MissionProgress.js'
import { SwarmBoard } from '../lib/types/client/SwarmBoard.js'
import { activityGroups } from '../lib/types/client/projection.js'
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
  // OWNER PASS 2026-09-11: members moved out of their disclosure into the top
  // dynamic area, each with an avatar and its own progress bar; the technical
  // pane stays opt-in and now opens on a title with unfoldable facts.
  assert.match(markup, /data-swarm-team=""/)
  assert.match(markup, /class="sw-bar"/)
  assert.match(markup, /data-swarm-details="technical"/)
  assert.doesNotMatch(markup, /data-swarm-details="team"/)
  assert.match(markup, /data-swarm-accepted="">1 \/ 5 tasks accepted/)
  assert.doesNotMatch(markup, /role="tab"|class="sw-metrics"|class="sw-board"/)
  assert.equal((markup.match(/data-swarm-progress-event=/g) ?? []).length, 3)
  const expanded = render(SwarmBoard, { snapshot, initialView: 'graph' })
  assert.match(expanded, /data-swarm-details="technical" open=""/)
  assert.match(expanded, /data-swarm-details="mission"/, 'the detailed facts unfold inside the technical pane')
  assert.match(expanded, /class="sw-fact-title"/, 'that pane opens on a title')
  assert.match(expanded, /role="tabpanel" aria-label="Dependency graph"/)
  const chinese = render(SwarmBoard, { snapshot }, true)
  assert.match(chinese, /智能体正在思考/)
  assert.match(chinese, /任务与资源详情/)
  assert.match(chinese, /项已验收/)
})


test('OWNER PASS 2026-09-11: members sit in the dynamic area with an avatar and their own live bar', () => {
  const snapshot = uiSnapshot()
  const markup = render(SwarmBoard, { snapshot, onOpenWorker() {} })
  // Item 5: the roster is part of the default overview, above the opt-in
  // technical pane, and it is no longer a disclosure.
  const team = markup.indexOf('data-swarm-team')
  const technical = markup.indexOf('data-swarm-details="technical"')
  assert.ok(team > 0 && technical > team, 'the team strip precedes the technical pane')
  assert.doesNotMatch(markup, /data-swarm-details="team"/)
  // Item 1: the mission focus line draws no avatar; the sprite lives in the rows.
  const focus = markup.slice(markup.indexOf('class="sw-focus"'), markup.indexOf('data-swarm-team'))
  assert.doesNotMatch(focus, /<svg/, 'the focus line carries no avatar')
  assert.equal((markup.match(/class="sw-worker-avatar"/g) ?? []).length, snapshot.members.length, 'one sprite per member row')
  assert.doesNotMatch(markup, /class="sw-avatar"/, 'the initials block is gone')
  // Item 2/5: every member row carries a bar; a step ceiling is determinate and a
  // bare attempt is a lease countdown (never an invented percentage).
  assert.equal((markup.match(/class="sw-bar"/g) ?? []).length, snapshot.members.length, 'one bar per member')
  assert.match(markup, /data-swarm-member-basis="lease"/, 'the running attempt shows its lease')
  assert.match(markup, /data-basis="lease"/, 'and the bar is the lease one')
  const ceiling = uiSnapshot()
  ceiling.tasks[1].usedSteps = 3
  ceiling.tasks[1].maxSteps = 12
  const bounded = render(SwarmBoard, { snapshot: ceiling, onOpenWorker() {} })
  assert.match(bounded, /data-swarm-member-basis="steps">steps 3\/12</, 'a declared step ceiling shows the ratio')
  assert.match(bounded, /data-basis="steps"/, 'the bounded bar is the step one')
  assert.match(bounded, /role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="25"/, 'a bounded bar is a meter, not an animation')
  assert.match(bounded, /<span style="width:25%">/, 'and its width is the durable ratio')
})

test('OWNER PASS 2026-09-11: the technical pane opens on a title, and the facts unfold below it', () => {
  const markup = render(SwarmBoard, { snapshot: uiSnapshot(), initialView: 'board' })
  const facts = markup.indexOf('data-swarm-details="mission"')
  assert.ok(facts > 0, 'the facts disclosure exists inside the technical pane')
  assert.ok(markup.indexOf('class="sw-fact-title"') > facts, 'it opens on the mission title')
  assert.ok(markup.indexOf('class="sw-metrics"') > facts, 'the metrics grid is inside the unfoldable facts')
  assert.ok(!markup.includes('data-swarm-details="mission" open='), 'and it is collapsed by default')
})


test('OWNER PASS 2026-09-11: the new team labels are translated, not English leaks', () => {
  const snapshot = uiSnapshot()
  const chinese = render(SwarmBoard, { snapshot, onOpenWorker() {} }, true)
  assert.match(chinese, /团队动态/, 'the team strip title is translated')
  assert.match(chinese, /名成员/, 'the member count is translated')
  assert.match(chinese, /工作中/, 'a working member reads in Chinese')
  assert.doesNotMatch(chinese, />Team activity</, 'no English team label leaks')
  const cancelled = uiSnapshot()
  cancelled.tasks[4] = { ...cancelled.tasks[4], status: 'cancelled' }
  const lanes = render(SwarmBoard, { snapshot: cancelled, initialView: 'board' }, true)
  assert.match(lanes, /已取消/, 'the cancelled lane is translated')
  assert.doesNotMatch(lanes, />Cancelled</, 'and it is not left in English')
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

test('OWNER PASS 2026-09-11 (second pass, item 1): the activity feed is grouped by durable actor', () => {
  // Fixture order: seq 1 owner, seq 2 member a, seq 3 and 4 member b.
  const snapshot = uiSnapshot()
  const groups = activityGroups(snapshot)
  assert.deepEqual(groups.map(group => group.actor), ['b', 'a', 'owner'], 'the group with the newest event leads')
  assert.deepEqual(groups.map(group => group.events.map(event => event.seq)), [[4, 3], [2], [1]], 'each group is newest-first inside')
  assert.equal(groups[0].name, 'Nova', 'a member actor is named by its member row')
  assert.equal(groups[0].member.id, 'b')
  assert.equal(groups.at(-1).name, 'Owner conversation', 'a non-member writer gets a role label, not a raw key')
  assert.equal(groups.at(-1).member, undefined, 'and no invented member row')
  const unknown = { ...snapshot, members: [], events: [{ seq: 1, missionId: snapshot.mission.id, type: 'task/accepted', actor: 'member_9f3ac1', data: {}, createdAt: 1 }] }
  assert.equal(activityGroups(unknown)[0].name, 'member_9', 'an unknown actor is shortened, never invented')
  const markup = render(SwarmBoard, { snapshot, initialView: 'activity' })
  assert.deepEqual([...markup.matchAll(/data-swarm-activity-group="([^"]+)"/g)].map(match => match[1]), ['b', 'a', 'owner'],
    'the rendered groups keep the derived order')
  assert.match(markup, /data-swarm-activity-group="b"[\s\S]*?class="sw-worker-avatar"/, 'a member group header draws that member’s sprite')
  assert.match(markup, /data-swarm-activity-group="b"[\s\S]*?2 events/, 'and its own event count')
  assert.doesNotMatch(markup, /data-swarm-activity-group="owner"[\s\S]*?sw-worker-avatar/, 'the owner group draws no worker sprite')
  assert.equal((markup.match(/class="sw-event"/g) ?? []).length, snapshot.events.length, 'grouping keeps every event row')
  assert.doesNotMatch(markup, /class="sw-event-data">a · |class="sw-event-data">b · /, 'a row no longer repeats the actor its header already names')
})

test('OWNER PASS 2026-09-11 (second pass, item 2): lane counts lead the board and empty lanes collapse', () => {
  const snapshot = uiSnapshot()
  const markup = render(SwarmBoard, { snapshot, initialView: 'board' })
  assert.match(markup, /data-swarm-lane-counts=""/, 'the distribution strip exists')
  const chips = [...markup.matchAll(/data-lane-count="([^"]+)" data-empty="(true|false)">[^<]*<b>(\d+)<\/b>/g)]
    .map(match => ({ lane: match[1], empty: match[2] === 'true', count: Number(match[3]) }))
  assert.equal(chips.length, 7, 'all seven lanes are counted')
  const cards = new Map()
  for (const card of markup.matchAll(/class="sw-task" data-lane="([^"]+)"/g)) cards.set(card[1], (cards.get(card[1]) ?? 0) + 1)
  for (const chip of chips) {
    assert.equal(chip.count, cards.get(chip.lane) ?? 0, `the ${chip.lane} count matches its column`)
    assert.equal(chip.empty, chip.count === 0, `the ${chip.lane} chip agrees with its own emptiness`)
  }
  assert.ok(chips.some(chip => chip.count > 0) && chips.some(chip => chip.count === 0), 'the fixture exercises an occupied and an empty lane')
  const empty = chips.find(chip => chip.empty)
  const at = markup.indexOf(`class="sw-lane" data-lane="${empty.lane}" data-empty=""`)
  assert.ok(at > 0, `the empty ${empty.lane} lane is marked collapsed`)
  const lane = markup.slice(at, markup.indexOf('</section>', at))
  assert.match(lane, /sw-lane-void/, 'an empty lane draws one thin rule instead of a dashed placeholder box')
  assert.doesNotMatch(lane, /class="sw-task"|class="sw-empty"/, 'and holds neither a card nor a placeholder')
  const occupied = chips.find(chip => chip.count > 0)
  assert.match(markup, new RegExp(`class="sw-lane" data-lane="${occupied.lane}"(?! data-empty)`), 'an occupied lane stays a normal column')
  assert.match(markup, /Work board <span class="sw-count">5<\/span>/, 'the board tab counts the tasks it holds')
  assert.match(markup, /Dependency graph <span class="sw-count">5<\/span>/, 'and so does the graph tab')
})

test('OWNER PASS 2026-09-11 (second pass, item 3): a long durable reason is one clipped line that unfolds', () => {
  const long = `Workspace preparation failed: ${'uncommitted work under a deeply nested path '.repeat(6)}`
  const blocked = uiSnapshot()
  blocked.events.push({ seq: 30, missionId: blocked.mission.id, type: 'task/blocked', actor: 'runtime', data: { taskId: 't5', reason: long }, createdAt: blocked.mission.updatedAt })
  const markup = render(SwarmBoard, { snapshot: blocked, initialView: 'board' })
  assert.match(markup, /data-swarm-reason="full"/, 'a paragraph-sized reason becomes a disclosure')
  const summary = (markup.match(/<summary data-swarm-task-reason="">([\s\S]*?)<\/summary>/) ?? [])[1]
  assert.ok(summary && summary.length < 130, `the collapsed line stays on one line, saw ${summary?.length}`)
  assert.ok(summary.endsWith('…'), 'the clip is visible, never silent')
  assert.ok(markup.includes(long), 'and the full reason is one disclosure away')
  const short = uiSnapshot()
  short.events.push({ seq: 31, missionId: short.mission.id, type: 'task/blocked', actor: 'runtime', data: { taskId: 't5', reason: 'Workspace preparation failed' }, createdAt: short.mission.updatedAt })
  const inline = render(SwarmBoard, { snapshot: short, initialView: 'board' })
  assert.match(inline, /data-swarm-task-reason="">Workspace preparation failed<\/p>/, 'a short reason stays on the card, inline')
  assert.doesNotMatch(inline, /data-swarm-reason="full"/, 'with no second disclosure to open')
})

test('OWNER PASS 2026-09-11 (second pass, item 5): the focus line states what its phase was derived from', () => {
  // The fixture has a submitted artifact with no live review, so the projection
  // waits for the owner and the disclosure shows exactly that fact.
  const markup = render(SwarmBoard, { snapshot: uiSnapshot() })
  assert.match(markup, /data-swarm-owner-state="waiting-for-owner"/, 'the disclosure carries the projected phase')
  assert.match(markup, /data-swarm-owner-label="">Waiting for your decision<\/p>/, 'and the projection’s own label')
  assert.match(markup, /data-swarm-owner-note="">A submitted artifact has no live independent review path\.<\/p>/)
  assert.match(markup, /data-swarm-owner-evidence="">task t4 status=submitted without a live review<\/span>/, 'the durable fact behind the phase is printed')
  assert.match(markup, /data-swarm-decision-content="">Admit an independent review or cancel the submission\./, 'and the decision says what to do about it')
  // A running task is the working phase, with the same derivation available.
  const running = uiSnapshot()
  running.tasks[3] = { ...running.tasks[3], status: 'accepted' }
  const runningMarkup = render(SwarmBoard, { snapshot: running })
  assert.match(runningMarkup, /data-swarm-owner-state="working"/)
  assert.match(runningMarkup, /data-swarm-owner-label="">Task in progress<\/p>/)
  assert.match(runningMarkup, /data-swarm-owner-evidence="">task t2 status=running<\/span>/)
  // A count travels beside the label instead of inside a sentence no catalogue can translate.
  const many = { ...running, tasks: running.tasks.map(task => task.id === 't5' ? { ...task, status: 'running' } : task) }
  assert.match(render(SwarmBoard, { snapshot: many }), /data-swarm-owner-label="">Tasks in progress 2<\/p>/)
  // A blocked task states the decision it waits for, including its content.
  const blocked = uiSnapshot()
  blocked.tasks[2] = { ...blocked.tasks[2], status: 'blocked' }
  const blockedMarkup = render(SwarmBoard, { snapshot: blocked })
  assert.match(blockedMarkup, /data-swarm-owner-state="waiting-for-owner"/)
  assert.match(blockedMarkup, /data-swarm-owner-label="">Waiting for your decision<\/p>/)
  assert.match(blockedMarkup, /data-swarm-owner-note="">Cannot make progress without a repair\.<\/p>/)
  assert.match(blockedMarkup, /data-swarm-decision-content="">Repair the task or withdraw it\./)
  assert.match(blockedMarkup, /data-swarm-owner-evidence="">task t3 status=blocked epoch 1<\/span>/)
  const chinese = render(SwarmBoard, { snapshot: blocked }, true)
  assert.match(chinese, /状态依据/, 'the provenance summary is translated')
  assert.match(chinese, /等待你决定/, 'so is the phase label that used to be English-only')
  assert.match(chinese, /依据: /, 'and the derivation line')
  assert.doesNotMatch(chinese, /Why this state|Derived from|Waiting for your decision|consumption unknown/, 'the focus line leaks no English copy')
})
