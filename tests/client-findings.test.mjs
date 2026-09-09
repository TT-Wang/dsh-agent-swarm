/**
 * Round-4 client findings: F-14 (event surfacing), F-15 (visible Stop/Complete),
 * F-16 (lineage/lane reconciliation), F-17 (snapshot validation), F-33 (zh
 * gaps), F-34 (linear render), F-35 (cancel + reason surface) and the client
 * side of F-12/F-13 (durable verdict naming, retained event window).
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { uiSnapshot } from './fixtures/ui-snapshot.mjs'
import { boardIndex, dependencyMet, durableVerdict, eventSummary, readSnapshot, retiredReviews, snapshotFromResult, taskLane } from '../lib/types/client/projection.js'
import { recentProgress, taskReasons } from '../lib/types/client/progress.js'
import { SwarmBoard } from '../lib/types/client/SwarmBoard.js'
import { RecentProgress } from '../lib/types/client/MissionProgress.js'
import { ActivityPanel } from '../lib/types/client/ActivityPanel.js'
import { DraftEditor, newPlan } from '../lib/types/client/DraftEditor.js'
import { CopyContext, zh } from '../lib/types/client/locale.js'
import { graphLayout } from '../lib/types/client/DependencyGraph.js'

const render = (component, props, chinese = false) => {
  const element = React.createElement(component, props)
  return renderToStaticMarkup(chinese ? React.createElement(CopyContext.Provider, { value: text => zh[text] ?? text }, element) : element)
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
const missionState = (snapshot, overrides = {}) => ({
  ownerSessionId: 'owner', workspace: '/repo', snapshots: [snapshot], drafts: [], starts: [], writable: true, ownerLive: true,
  defaultBudget: snapshot.mission.budget, connection: 'connected', loading: false, ...overrides,
})
const panelState = (snapshot, overrides = {}) => ({ ownerSessionId: 'owner', data: missionState(snapshot, overrides), loading: false, connection: 'connected' })

/** Every task-array scan is counted; a render path must not rescan per task or per edge. */
function countingTasks(tasks) {
  const counts = { find: 0, filter: 0 }
  const proxy = new Proxy(tasks, {
    get(target, property, receiver) {
      if (property === 'find' || property === 'filter') {
        counts[property] += 1
        return (...args) => { counts[property] += 1; return Array.prototype[property].apply(target, args) }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { proxy, counts }
}

test('F-14: the compact panel surfaces every recovery/control event type and prefers the durable reason', () => {
  const snapshot = uiSnapshot(), at = snapshot.mission.updatedAt
  const emitted = ['task/cancelled', 'task/checkpointed', 'task/checkpoint-failed', 'task/closeout-nudged',
    'task/closeout-abandoned', 'task/closeout-failed', 'task/git-write-denied']
  snapshot.events.push(
    { seq: 10, type: 'task/blocked', data: { taskId: 't2', reason: 'Workspace preparation failed: uncommitted work' }, createdAt: at },
    ...emitted.map((type, index) => ({ seq: 11 + index, type, data: { taskId: 't2', reason: `reason-${index}` }, createdAt: at + index })),
  )
  snapshot.events.at(-1).data = { taskId: 't2', command: 'git add -A', runId: 'run_123' }
  const events = recentProgress(snapshot, 20)
  const labels = events.map(event => event.label)
  for (const label of ['Task cancelled', 'Task workspace checkpointed', 'Task workspace checkpoint failed',
    'Worker asked to close out', 'Abandoned task workspace recovered', 'Task close-out failed', 'Worker git write denied']) {
    assert.ok(labels.includes(label), `missing compact label ${label}`)
  }
  // W9: the blocked reason, not the task title, is the owner-facing detail.
  const blocked = events.find(event => event.label === 'Task needs attention')
  assert.equal(blocked.detail, 'Workspace preparation failed: uncommitted work')
  assert.equal(blocked.detail === snapshot.tasks[1].title, false)
  const denied = events.find(event => event.label === 'Worker git write denied')
  assert.equal(denied.detail, 'git add -A · run_123', 'a git denial names its command and host run id')
  const reasons = taskReasons(snapshot)
  assert.equal(reasons.get('t2'), 'git add -A · run_123', 'the latest durable reason wins')
  // eventSummary keeps command/runId but never arbitrary raw payload keys.
  const summary = eventSummary({ command: 'git add -A', runId: 'run_123', rawArguments: 'secret', outcome: 'supported' })
  assert.match(summary, /command: git add -A/)
  assert.match(summary, /runId: run_123/)
  assert.match(summary, /outcome: supported/)
  assert.doesNotMatch(summary, /rawArguments|secret/)
})

test('task/ceiling-exhausted renders a compact ceiling block with a translated label', () => {
  const snapshot = uiSnapshot(), at = snapshot.mission.updatedAt
  snapshot.events.push({ seq: 30, type: 'task/ceiling-exhausted', actor: 'runtime',
    data: { taskId: 't2', dimension: 'steps', limit: 8, used: 8, code: 'task_ceiling_exhausted' }, createdAt: at })
  const events = recentProgress(snapshot, 20)
  const ceiling = events.find(event => event.label === 'Task ceiling reached')
  assert.ok(ceiling, 'the compact projection surfaces the ceiling block')
  assert.equal(ceiling.detail, 'steps · 8/8 · task_ceiling_exhausted', 'the dimension and exhausted limit are the owner-facing detail')
  assert.equal(ceiling.detail === snapshot.tasks.find(task => task.id === 't2').title, false)
  // The panel translates the label in both languages.
  assert.match(render(RecentProgress, { snapshot }), /Task ceiling reached/)
  const chinese = render(RecentProgress, { snapshot }, true)
  assert.match(chinese, /子任务超出执行上限/)
  assert.doesNotMatch(chinese, />Task ceiling reached</)
  assert.equal(zh['ceiling-exhausted'], '执行上限已耗尽', 'the event-type token is translated too')
  // A ceiling block without numbers still falls back to the task title.
  const bare = { ...snapshot, events: [{ seq: 31, type: 'task/ceiling-exhausted', actor: 'runtime', data: { taskId: 't2' }, createdAt: at }] }
  assert.equal(recentProgress(bare, 20)[0].detail, snapshot.tasks.find(task => task.id === 't2').title)
})

test('task/preparation-failed renders the reason and recovery credit with a translated label', () => {
  const snapshot = uiSnapshot(), at = snapshot.mission.updatedAt
  snapshot.events.push({ seq: 30, type: 'task/preparation-failed', actor: 'runtime',
    data: { taskId: 't2', epoch: 2, reason: 'Workspace preparation failed: uncommitted work', recoveryCount: 1, maxRecoveryAttempts: 3, status: 'blocked' }, createdAt: at })
  const events = recentProgress(snapshot, 20)
  const failure = events.find(event => event.label === 'Task preparation failed')
  assert.ok(failure, 'the compact projection surfaces the preparation failure')
  assert.equal(failure.detail, 'Workspace preparation failed: uncommitted work · recovery 1/3', 'the cause and the spent recovery credit are the owner-facing detail')
  assert.equal(failure.detail === snapshot.tasks.find(task => task.id === 't2').title, false)
  // The panel translates the label in both languages.
  assert.match(render(RecentProgress, { snapshot }), /Task preparation failed/)
  const chinese = render(RecentProgress, { snapshot }, true)
  assert.match(chinese, /子任务准备失败/)
  assert.doesNotMatch(chinese, />Task preparation failed</)
  assert.equal(zh['preparation-failed'], '准备失败', 'the event-type token is translated too')
  // A reason without recovery numbers keeps a clean separator.
  const reasonOnly = { ...snapshot, events: [{ seq: 31, type: 'task/preparation-failed', actor: 'runtime', data: { taskId: 't2', reason: 'prepare failed' }, createdAt: at }] }
  assert.equal(recentProgress(reasonOnly, 20)[0].detail, 'prepare failed')
  // Without a reason or recovery credit the task title remains the fallback.
  const bare = { ...snapshot, events: [{ seq: 32, type: 'task/preparation-failed', actor: 'runtime', data: { taskId: 't2' }, createdAt: at }] }
  assert.equal(recentProgress(bare, 20)[0].detail, snapshot.tasks.find(task => task.id === 't2').title)
})

test('F-15: Stop and Complete render in the overview without opening the technical disclosure', () => {
  const snapshot = uiSnapshot()
  const html = render(ActivityPanel, panelProps(panelState(snapshot)))
  assert.match(html, /data-action="stop"/, 'Stop is an overview control')
  assert.match(html, /data-action="complete"/, 'Complete is an overview control')
  assert.doesNotMatch(html, /data-swarm-details="technical" open/, 'the disclosure stays collapsed')
  assert.match(html, /data-swarm-advanced-controls=""/)
  // An automatic mission has no Complete control but keeps Stop visible.
  const automatic = render(ActivityPanel, panelProps(panelState(snapshot, {
    starts: [{ id: 'start-1', missionId: snapshot.mission.id, draftId: 'draft-1', status: 'running', goal: 'g', createdAt: 1 }],
  })))
  assert.match(automatic, /data-action="stop"/)
  assert.doesNotMatch(automatic, /data-action="complete"/)
})

test('F-16: client lineage fails closed on ambiguity and matches the runtime oldest-wins rule', () => {
  const base = (id, status, extra = {}) => ({ id, missionId: 'm', workstreamId: 'w', title: id, objective: id, kind: 'implementation',
    dependencies: [], scope: ['src/'], acceptance: ['a'], checks: [], status, priority: 1, experiment: false, epoch: 1, evidenceIds: [], createdAt: 1, ...extra })
  const original = base('orig', 'blocked')
  const older = base('rep-old', 'accepted', { replaces: ['orig'], createdAt: 2 })
  const newer = base('rep-new', 'accepted', { replaces: ['orig'], createdAt: 3 })
  const dependent = base('dep', 'pending', { dependencies: ['orig'], kind: 'research' })
  // Two accepted repairs for one obligation is ambiguous history: the runtime refuses the claim.
  assert.equal(dependencyMet('orig', [original, newer, older, dependent]), false)
  assert.equal(taskLane(dependent, [original, newer, older, dependent]), 'blocked')
  // One accepted repair resolves the reference.
  assert.equal(dependencyMet('orig', [original, older, dependent]), true)
  assert.equal(taskLane(dependent, [original, older, dependent]), 'ready')
  // Oldest live repair wins while nothing is accepted.
  const pendingOld = base('rep-old', 'running', { replaces: ['orig'], createdAt: 1 })
  const pendingNew = base('rep-new', 'pending', { replaces: ['orig'], createdAt: 2 })
  assert.equal(dependencyMet('orig', [original, pendingNew, pendingOld, dependent]), false, 'a live but unaccepted repair does not satisfy')
  assert.equal(dependencyMet('orig', [original, pendingOld, { ...pendingNew, status: 'accepted' }, dependent]), true)
  // A different kind is not a repair of this obligation.
  assert.equal(dependencyMet('orig', [original, { ...older, kind: 'research' }, dependent]), false)
  // Lane mirrors runtime unschedulable: stopped assignee and unsubmitted review source.
  const stopped = base('assigned', 'pending', { assigneeId: 'gone' })
  assert.equal(taskLane(stopped, [stopped]), 'ready', 'compatibility call without members keeps the historical lane')
  assert.equal(boardIndex([stopped]).lane(stopped, [{ id: 'gone', status: 'stopped' }]), 'blocked')
  assert.equal(boardIndex([stopped]).lane(stopped, [{ id: 'gone', status: 'idle' }]), 'ready')
  const review = base('review', 'pending', { kind: 'verification', reviewOf: 'orig' })
  assert.equal(taskLane(review, [original, older, review]), 'blocked', 'review waits for the source submission')
  assert.equal(taskLane(review, [{ ...original, status: 'submitted' }, older, review]), 'ready')
})

test('F-17: malformed snapshot fields are rejected instead of throwing during render', () => {
  const snapshot = uiSnapshot()
  const malformed = (patch, tasks) => ({ ...snapshot, ...patch, ...(tasks === undefined ? {} : { tasks }) })
  assert.equal(readSnapshot(malformed({}, snapshot.tasks.map(task => task.id === 't1' ? { ...task, output: 5 } : task))), undefined)
  assert.equal(snapshotFromResult({ swarmSnapshot: malformed({}, snapshot.tasks.map(task => task.id === 't1' ? { ...task, output: 5 } : task)) }, []), undefined)
  assert.equal(readSnapshot(malformed({}, snapshot.tasks.map(task => task.id === 't1' ? { ...task, objective: { text: 'x' } } : task))), undefined)
  assert.equal(readSnapshot(malformed({}, snapshot.tasks.map(task => task.id === 't1' ? { ...task, dependencies: [1] } : task))), undefined)
  assert.equal(readSnapshot(malformed({ mission: { ...snapshot.mission, reason: 5 } })), undefined)
  assert.equal(readSnapshot(malformed({ pendingDeliveries: 'many' })), undefined)
  assert.deepEqual(readSnapshot(snapshot), snapshot, 'the valid fixture still passes')
  // The completion summary dereferences task.output; a rejected snapshot never reaches it.
  const completed = { ...snapshot, mission: { ...snapshot.mission, status: 'completed' }, tasks: snapshot.tasks.map(task => ({ ...task, output: 5 })) }
  assert.equal(readSnapshot(completed), undefined)
  assert.doesNotThrow(() => render(SwarmBoard, { snapshot, initialView: 'board' }))
})

test('F-33: zh translates dynamic verdict, kind and event vocabulary', () => {
  const snapshot = uiSnapshot()
  snapshot.evidence[0].outcome = 'supported'
  snapshot.evidence.push({ ...snapshot.evidence[1], id: 'ev-3', status: 'unverified', outcome: 'disproved', claim: 'Untranslated outcome', challenges: [], artifact: undefined })
  snapshot.events.push({ seq: 20, type: 'task/blocked', actor: 'runtime', data: { taskId: 't2', reason: 'blocked reason' }, createdAt: snapshot.mission.updatedAt })
  const board = render(SwarmBoard, { snapshot, initialView: 'board' }, true)
  assert.match(board, /实现/, 'task kind is translated')
  assert.match(board, /验证/, 'verification kind is translated')
  assert.doesNotMatch(board, />implementation</, 'raw kind never renders')
  const evidence = render(SwarmBoard, { snapshot, initialView: 'evidence' }, true)
  assert.match(evidence, /支持/)
  assert.match(evidence, /未验证/)
  assert.match(evidence, /已证伪/)
  assert.doesNotMatch(evidence, />unverified</)
  const activity = render(SwarmBoard, { snapshot, initialView: 'activity' }, true)
  assert.match(activity, /子任务 \/ 受阻/, 'event vocabulary tokens are translated')
  assert.doesNotMatch(activity, /task \/ blocked/)
  const graph = render(SwarmBoard, { snapshot, initialView: 'graph' }, true)
  assert.match(graph, /实现/)
  assert.doesNotMatch(graph, />implementation · /)
  // The verifier's 15 English-only event types plus the round-4 additions.
  const vocabulary = ['task/rejected', 'mission/recovered', 'mission/budget-warning', 'member/added', 'member/subscribed',
    'task/lease-expiring', 'task/closeout-ready', 'task/closeout-exhausted', 'task/budget-resumed', 'task/budget-resume-skipped',
    'task/quiescence-recovered', 'workstream/created', 'member/activity', 'member/resume-failed', 'automatic/requested',
    'task/review-retired', 'member/effort-downgraded', 'mission/budget-quiesced', 'task/ceiling-exhausted', 'task/preparation-failed']
  for (const type of vocabulary) for (const token of type.split('/')) assert.ok(zh[token], `zh token ${token} missing for ${type}`)
  const vocabularySnapshot = uiSnapshot()
  vocabularySnapshot.events = vocabulary.map((type, index) => ({ seq: 100 + index, missionId: vocabularySnapshot.mission.id,
    type, actor: 'runtime', data: {}, createdAt: vocabularySnapshot.mission.updatedAt + index }))
  const translated = render(SwarmBoard, { snapshot: vocabularySnapshot, initialView: 'activity' }, true)
  assert.doesNotMatch(translated, /task \/ rejected|mission \/ recovered|budget-warning|member \/ added|subscribed|lease-expiring|closeout-ready|closeout-exhausted|budget-resumed|budget-resume-skipped|quiescence-recovered|workstream \/ created|member \/ activity|resume-failed|automatic \/ requested|review-retired|effort-downgraded|budget-quiesced|preparation-failed/)
})

/** Counts calls and predicate probes for every find/filter on the task array. */
function probingTasks(tasks) {
  const stats = { findCalls: 0, filterCalls: 0, findProbes: 0, filterProbes: 0 }
  const proxy = new Proxy(tasks, {
    get(target, property, receiver) {
      if (property === 'find' || property === 'filter') {
        stats[`${property}Calls`] += 1
        return (predicate, thisArg) => Array.prototype[property].apply(target,
          [(value, index, array) => { stats[`${property}Probes`] += 1; return predicate(value, index, array) }, thisArg])
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { proxy, stats }
}

/** A mission at scale: every task has a dependency, every task has a durable event. */
function bulkSnapshot(size) {
  const snapshot = uiSnapshot()
  snapshot.members = [{ ...snapshot.members[0], id: 'bulk-owner', status: 'working' }]
  snapshot.tasks = Array.from({ length: size }, (_, i) => ({
    ...snapshot.tasks[0], id: `bulk-${i}`, title: `Bulk ${i}`, status: i === 0 ? 'running' : 'pending',
    dependencies: i === 0 ? [] : [`bulk-${i - 1}`], assigneeId: 'bulk-owner',
    artifact: undefined, evidenceIds: [], reviewOf: undefined,
    attempt: i === 0 ? { id: 'attempt-bulk', epoch: 1, ownerId: 'bulk-owner', leaseUntil: snapshot.mission.updatedAt + 60000 } : undefined,
  }))
  snapshot.events = Array.from({ length: size }, (_, i) => ({ seq: i + 1, missionId: snapshot.mission.id,
    type: i % 2 ? 'task/blocked' : 'task/submitted', actor: 'runtime',
    data: { taskId: `bulk-${i}`, reason: `reason-${i}` }, createdAt: snapshot.mission.updatedAt + i }))
  snapshot.evidence = snapshot.evidence.map((item, i) => ({ ...item, id: `ev-bulk-${i}`, taskId: `bulk-${i}` }))
  return snapshot
}

test('F-34: the real board render scans the task array linearly, not per task or per event', () => {
  // Structural check: index construction and graph layout never rescan.
  const tasks = uiSnapshot().tasks
  const { proxy, counts } = countingTasks(tasks)
  const index = boardIndex(proxy)
  for (const task of tasks) index.lane(task)
  assert.deepEqual(counts, { find: 0, filter: 0 }, 'lane resolution never rescans the task array')
  graphLayout(proxy)
  assert.deepEqual(counts, { find: 0, filter: 0 }, 'graph layout never rescans the task array per edge')

  // Real render path with dependencies AND events. The verifier's pre-fix probe
  // measured N+3 `find` calls with ~0.65N^2 predicate probes (50:1625 …
  // 800:326000); the fixed render performs zero `find` calls and 4N filter
  // probes (measured 200/400/800/1600/3200 for 50/100/200/400/800).
  const rendered = [60, 240, 960].map(size => {
    const snapshot = bulkSnapshot(size)
    const probe = probingTasks(snapshot.tasks)
    snapshot.tasks = probe.proxy
    const html = render(SwarmBoard, { snapshot, initialView: 'board' })
    assert.equal((html.match(/class="sw-task"/g) ?? []).length, size)
    return { size, ...probe.stats }
  })
  for (const { size, findCalls, findProbes, filterProbes } of rendered) {
    assert.equal(findCalls, 0, `${size}-task render still calls Array.find on the task array`)
    assert.equal(findProbes, 0, `${size}-task render still probes Array.find`)
    assert.ok(filterProbes > 0, 'the probe counts real scans')
    assert.ok(filterProbes < 12 * size, `${size}-task render probes ${filterProbes}`)
  }
  const small = rendered[0], large = rendered.at(-1)
  assert.ok(large.filterProbes / small.filterProbes < 40,
    `probe growth is superlinear: ${small.filterProbes} (${small.size}) -> ${large.filterProbes} (${large.size})`)
})

test('F-35: the panel offers a per-task cancel control and shows the W9 reason on the card', async () => {
  const snapshot = uiSnapshot()
  snapshot.events.push({ seq: 30, type: 'task/blocked', actor: 'runtime', data: { taskId: 't5', reason: 'Workspace preparation failed: uncommitted work' }, createdAt: snapshot.mission.updatedAt })
  const cancellable = render(SwarmBoard, { snapshot, initialView: 'board', onCancelTask() {} })
  assert.match(cancellable, /data-action="cancel-task"/)
  assert.match(cancellable, /data-swarm-task-reason=""/)
  assert.match(cancellable, /Workspace preparation failed: uncommitted work/)
  // A read-only board (no handler) and accepted work never offer cancellation.
  assert.doesNotMatch(render(SwarmBoard, { snapshot, initialView: 'board' }), /data-action="cancel-task"/)
  const readOnly = render(SwarmBoard, { snapshot: { ...snapshot, tasks: snapshot.tasks.map(task => ({ ...task, status: 'accepted' })) }, initialView: 'board', onCancelTask() {} })
  assert.doesNotMatch(readOnly, /data-action="cancel-task"/)
  // The sidebar wires the handler for writable owners; the compact overview
  // keeps task cards inside the collapsed board, which is where cancel lives.
  const writable = render(ActivityPanel, panelProps(panelState(snapshot)))
  assert.doesNotMatch(writable, /data-action="cancel-task"/)
  const source = await readFile(new URL('../src/client/ActivityPanel.tsx', import.meta.url), 'utf8')
  assert.match(source, /onCancelTask=\{data\?\.writable \? task => \{ void cancelTask\(task\) \} : undefined\}/,
    'ActivityPanel passes the owner cancel handler to the board')
  // W14/W8 runnability hints exist in the draft editor.
  const input = newPlan('/repo', snapshot.mission.budget)
  input.title = 'Hints'; input.objective = 'Show the runnability hints'
  const draft = { id: 'draft-ui', ownerSessionId: 'owner', revision: 1, status: 'draft', input, createdAt: 1, updatedAt: 1 }
  const editor = render(DraftEditor, { sessionId: 'owner', workspace: '/repo', budget: input.budget, draft, request: async () => ({}), onSaved() {}, onLaunched() {}, onDiscarded() {} })
  assert.match(editor, /data-swarm-checks-hint=""/)
  assert.match(editor, /data-swarm-model-hint=""/)
})

test('F-12/F-13 client surface: durable verdict naming, retired siblings, retained event window', () => {
  const snapshot = uiSnapshot()
  assert.equal(durableVerdict(snapshot, 'ev-1'), undefined, 'task/accepted does not name the evidence verdict')
  snapshot.events.push({ seq: 40, type: 'evidence/verified', actor: 'reviewer', data: { evidenceId: 'ev-1' }, createdAt: snapshot.mission.updatedAt })
  assert.deepEqual(durableVerdict(snapshot, 'ev-1'), { seq: 40, type: 'evidence/verified' })
  const withoutEvent = render(SwarmBoard, { snapshot: { ...snapshot, events: snapshot.events.filter(event => event.type !== 'evidence/verified') }, initialView: 'evidence' })
  assert.match(withoutEvent, /data-swarm-verdict-event="missing"/)
  assert.match(withoutEvent, /No durable event names this verdict yet/)
  const withEvent = render(SwarmBoard, { snapshot, initialView: 'evidence' })
  assert.match(withEvent, /data-swarm-verdict-event="40"/)
  assert.match(withEvent, /Durable verdict event: evidence\/verified/)
  // A retired sibling review is visible on the claim it reviewed.
  snapshot.tasks.push({ ...snapshot.tasks[2], id: 't3-retired', title: 'Retired sibling review', status: 'cancelled', reviewOf: 't1' })
  assert.deepEqual(retiredReviews(snapshot, 't1').map(review => review.id), ['t3-retired'])
  assert.match(render(SwarmBoard, { snapshot, initialView: 'evidence' }), /Retired reviews: Retired sibling review/)
  // The activity view shows the whole retained window, not an unexplained newest-40 slice.
  const many = uiSnapshot()
  many.events = Array.from({ length: 60 }, (_, i) => ({ seq: i + 1, type: 'task/accepted', actor: 'a', data: { taskId: 't1' }, createdAt: many.mission.updatedAt + i }))
  const activity = render(SwarmBoard, { snapshot: many, initialView: 'activity' })
  assert.equal((activity.match(/class="sw-event"/g) ?? []).length, 60)
  assert.match(activity, /events retained in this snapshot\./)
  assert.doesNotMatch(activity, /Showing the latest 40/)
})
