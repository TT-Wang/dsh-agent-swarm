/**
 * R14-F2 (b)/(c)/(d): the board's stall roots are named once per root@epoch
 * whether or not a healthy sibling is running, and the unnamed fall-through is
 * replaced by a silent-while-waiting, named-otherwise escalation.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { tempDirectory } from './temp-root.mjs'

const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 20, maxExperiments: 2 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
class Workers {
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(_mission, id) { return `/isolated/${id}` }
  async start() {}
  async deliver() {}
  async stop() {}
  isIdle() { return true }
  async captureArtifact() { return { commit: 'c', baseCommit: 'b', workspace: '/isolated', changedPaths: [] } }
  async verifyArtifact() { return [] }
  async prepareTask() {}
  async dispose() {}
}

async function fixture(t, config = {}) {
  const directory = await tempDirectory('swarm-stall-roots-')
  const runtime = new SwarmRuntime({ statePath: join(directory, 'db.sqlite'), leaseMs: 60000, tickMs: 25, maxMessageChars: 16000, maxEvents: 500, maxTasksPerMember: 9, ...config }, new Workers())
  await runtime.start()
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'stall-owner' }
  const mission = runtime.create(owner, { title: 'Stall roots', objective: 'Name the root', workspace: directory, scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const member = await runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  const actor = { sessionId: member.sessionId }
  const propose = (title, input = {}) => runtime.propose(owner, mission.id, { workstreamId: stream.id, title, objective: title, kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], assigneeId: member.id, ...input })
  const block = task => { const row = runtime.store.get('tasks', task.id); row.status = 'blocked'; row.epoch++; row.output = 'blocked for repair'; runtime.store.put('tasks', row); return runtime.store.get('tasks', task.id) }
  const cancel = task => { const row = runtime.store.get('tasks', task.id); row.status = 'cancelled'; runtime.store.put('tasks', row) }
  const notices = () => runtime.store.list('deliveries', mission.id).filter(delivery => delivery.to === 'owner')
  const stallRoots = () => notices().filter(delivery => typeof delivery.notice?.dedupKey === 'string' && delivery.notice.dedupKey.startsWith('stall-root:'))
  const fallthroughs = () => notices().filter(delivery => typeof delivery.notice?.dedupKey === 'string' && delivery.notice.dedupKey.startsWith('fallthrough:'))
  return { directory, runtime, owner, mission, member, actor, propose, block, cancel, notices, stallRoots, fallthroughs }
}

test('R14-F2(b): a blocked root is named once per root@epoch while a healthy sibling runs', async t => {
  const f = await fixture(t)
  const sibling = f.propose('Healthy sibling')
  await f.runtime.claim(f.actor, f.mission.id, sibling.id)
  // The dependent is admitted before the root dies (admission refuses a
  // dependency on a blocked task), then the durable edge is written directly.
  const dependent = f.propose('Depends on the root')
  const root = f.block(f.propose('Dead end'))
  const dependentRow = f.runtime.store.get('tasks', dependent.id)
  dependentRow.dependencies = [root.id]
  f.runtime.store.put('tasks', dependentRow)
  await sleep(200)
  const roots = f.stallRoots()
  assert.equal(roots.length, 1, `exactly one stall-root notice: ${JSON.stringify(roots.map(delivery => delivery.notice.dedupKey))}`)
  const notice = roots[0]
  assert.equal(notice.notice.dedupKey, `stall-root:${f.mission.id}:${root.id}@${root.epoch}`)
  assert.match(notice.content, new RegExp(root.id), 'the root is named')
  assert.match(notice.content, new RegExp(dependent.id), 'the dependent is named')
  assert.ok(Array.isArray(notice.subjects) && notice.subjects.includes(`${root.id}@${root.epoch}`), `the notice carries the root subject: ${JSON.stringify(notice.subjects)}`)
  assert.ok(notice.subjects.includes(`${dependent.id}@${dependent.epoch}`), 'the dependent subject is carried too')
  const event = f.runtime.store.events(f.mission.id, 200).filter(item => item.type === 'mission/stalled' && item.data?.cause === 'stall-root').at(-1)
  assert.ok(event, 'the stall root is durable with its own cause')
  assert.equal(event.data.taskId, root.id)
  await sleep(150)
  assert.equal(f.stallRoots().length, 1, 'the same root@epoch never repeats')
})

test('R14-F2(b): a blocked task with a live replacement is lineage, not a root', async t => {
  const f = await fixture(t)
  const source = f.block(f.propose('Superseded'))
  const replacement = f.propose('Live replacement', { replaces: [source.id] })
  await f.runtime.claim(f.actor, f.mission.id, replacement.id)
  await sleep(200)
  assert.equal(f.stallRoots().length, 0, 'a live replacement covers its lineage')
})

test('R14-F2(b/d): a stop awaited past the declared bound is a stall root', async t => {
  const f = await fixture(t, { stallPassTimeoutMs: 40 })
  const root = f.propose('Stuck stop')
  const row = f.runtime.store.get('tasks', root.id)
  row.status = 'blocked'; row.epoch++
  row.resumeAfterStop = { epoch: row.epoch, reason: 'handoff', at: Date.now() - 5000 }
  f.runtime.store.put('tasks', row)
  await sleep(150)
  const roots = f.stallRoots()
  assert.equal(roots.length, 1, 'an expired stop is a root')
  assert.match(roots[0].content, /awaited/, `the notice names the awaited stop: ${roots[0].content}`)
})

test('R14-F2(c): the runtime stays silent while every unfinished task is legitimately waiting', async t => {
  const f = await fixture(t)
  const running = f.propose('Running')
  await f.runtime.claim(f.actor, f.mission.id, running.id)
  f.propose('Waiting on the running task', { dependencies: [running.id] })
  await sleep(200)
  assert.equal(f.fallthroughs().length, 0, 'a live dependency is legitimate waiting, not silence')
})

test('R14-F2(c): a pending task whose predecessor is dead escalates and is named', async t => {
  const f = await fixture(t)
  // A healthy sibling keeps the board out of the W3 stall class, so the
  // fall-through escalation itself is what must name the dead-ended task.
  const sibling = f.propose('Healthy sibling')
  await f.runtime.claim(f.actor, f.mission.id, sibling.id)
  const dead = f.propose('Dead predecessor')
  const waiting = f.propose('Waiting on the dead one')
  const waitingRow = f.runtime.store.get('tasks', waiting.id)
  waitingRow.dependencies = [dead.id]
  f.runtime.store.put('tasks', waitingRow)
  f.cancel(dead)
  await sleep(200)
  const fallthroughs = f.fallthroughs()
  assert.equal(fallthroughs.length, 1, 'the unnamed fallback is replaced by a named escalation')
  const notice = fallthroughs[0]
  assert.match(notice.content, new RegExp(waiting.id), 'the unrecognised task is named')
  assert.ok(notice.subjects.includes(`${waiting.id}@${waiting.epoch}`), `the notice carries subjects: ${JSON.stringify(notice.subjects)}`)
  assert.ok(!notice.subjects.some(subject => subject.startsWith(`${sibling.id}@`)), 'the healthy sibling is not named')
  assert.doesNotMatch(notice.content, /made no progress this tick and no task is dispatchable/, 'the old unnamed message is gone')
})

test('R14-F2v D1: the stall-root event carries the unschedulable shape later readers use', async t => {
  const f = await fixture(t)
  const sibling = f.propose('Healthy sibling')
  await f.runtime.claim(f.actor, f.mission.id, sibling.id)
  const root = f.block(f.propose('Dead end'))
  await sleep(200)
  const events = f.runtime.store.events(f.mission.id, 200).filter(event => event.type === 'mission/stalled')
  const latest = events.at(-1)
  assert.equal(latest.data.cause, 'stall-root', 'the latest stall event is the stall root')
  assert.ok(Array.isArray(latest.data.unschedulable), `the latest mission/stalled event keeps the unschedulable list: ${JSON.stringify(latest.data)}`)
  assert.ok(latest.data.unschedulable.includes(root.id), 'the root is in the unschedulable list')
})

test('R14-F2v D2: a stop with no recorded start is a root, never silence', async t => {
  const f = await fixture(t)
  const sibling = f.propose('Healthy sibling')
  await f.runtime.claim(f.actor, f.mission.id, sibling.id)
  const stuck = f.propose('Untimestamped stop')
  const row = f.runtime.store.get('tasks', stuck.id)
  row.status = 'blocked'; row.epoch++
  row.resumeAfterStop = { epoch: row.epoch, reason: 'handoff' }
  f.runtime.store.put('tasks', row)
  await sleep(200)
  const roots = f.stallRoots()
  assert.equal(roots.length, 1, `an untimestamped stop escalates instead of staying silent: ${JSON.stringify(f.notices().map(delivery => delivery.notice?.dedupKey))}`)
  assert.equal(f.fallthroughs().length, 0, 'the root path names it, the fall-through is not needed')
  assert.match(roots[0].content, /no recorded start/, `the notice states why the bound cannot hold: ${roots[0].content}`)
})
