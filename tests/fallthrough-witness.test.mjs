/**
 * R14-F2(a): every owner notice carries `subjects` (taskId@epoch) in the same
 * transaction as the transition, so a notice about one task is never consumed
 * by an unrelated one.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeWorkers, makeRuntime } from './faults/harness.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function fixture(t, config = {}) {
  const { dir: directory, runtime, budget } = await makeRuntime(t, {
    workers: new FakeWorkers({ autoIdle: true, artifact: { commit: 'c', baseCommit: 'b', workspace: '/isolated', changedPaths: [] }, checks: [] }),
    config: { tickMs: 25, maxEvents: 500, maxTasksPerMember: 9, checkTimeoutMs: undefined, ...config },
    budget: { maxTokens: 100000, maxSteps: 100, maxTasks: 20, maxExperiments: 2 },
  })
  await runtime.start()
  const owner = { sessionId: 'fallthrough-owner' }
  const mission = runtime.create(owner, { title: 'Fall-through', objective: 'Name the wake', workspace: directory, scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const member = await runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  const actor = { sessionId: member.sessionId }
  const propose = (title, input = {}) => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title, objective: title, kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], assigneeId: member.id, ...input })
  const notices = () => runtime.store.list('deliveries', mission.id).filter(delivery => delivery.to === 'owner')
  const block = task => { const row = runtime.store.get('tasks', task.id); row.status = 'blocked'; row.epoch++; row.output = 'blocked for repair'; runtime.store.put('tasks', row); return runtime.store.get('tasks', row.id) }
  return { directory, runtime, owner, mission, member, actor, propose, notices, block }
}

test('R14-F2(a): an owner notice carries the task subjects it was produced for', async t => {
  const f = await fixture(t)
  const running = f.propose('Healthy')
  await f.runtime.claim(f.actor, f.mission.id, running.id)
  const root = f.block(f.propose('Root'))
  await sleep(200)
  const notice = f.notices().find(delivery => typeof delivery.notice?.dedupKey === 'string' && delivery.notice.dedupKey.startsWith('stall-root:'))
  assert.ok(notice, 'the stall-root notice exists')
  assert.deepEqual(notice.subjects, [`${root.id}@${root.epoch}`], 'subjects name the task and its epoch exactly')
  // A notice written for one task is not consumed by another task's notice: the
  // dedup key is the root's identity, not the board fingerprint.
  const unrelated = f.propose('Unrelated work')
  f.runtime.notify(f.mission.id, 'Unrelated owner notice about another task', [`${unrelated.id}@1`], { from: 'runtime', noticeClass: 'decision', dedupe: false })
  await sleep(150)
  assert.equal(f.notices().filter(delivery => typeof delivery.notice?.dedupKey === 'string' && delivery.notice.dedupKey.startsWith('stall-root:')).length, 1, 'an unrelated notice does not consume or duplicate the stall root')
})

test('R14-F2(a): subjects are written in the same durable row as the notice, not merged later', async t => {
  const f = await fixture(t)
  const root = f.block(f.propose('Root'))
  await sleep(200)
  const notice = f.notices().find(delivery => typeof delivery.notice?.dedupKey === 'string' && delivery.notice.dedupKey.startsWith('stall-root:'))
  assert.ok(notice, 'the notice exists')
  const reloaded = f.runtime.store.get('deliveries', notice.id)
  assert.deepEqual(reloaded.subjects, [`${root.id}@${root.epoch}`], 'the durable row itself carries the subjects')
  assert.equal(reloaded.notice.dedupKey, `stall-root:${f.mission.id}:${root.id}@${root.epoch}`)
})
