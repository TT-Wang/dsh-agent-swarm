/**
 * OWNER QUIET: a mission the owner took out of play stops talking.
 *
 * Why: `control()` writes no notice for its own pause/stop — the decision is the
 * owner's and the panel shows it — but `flushOutbox` delivered every queued
 * owner row regardless of mission status. So a mission the owner had just
 * paused or stopped kept delivering the decisions it had queued earlier, which
 * the owner correctly reported as the swarm "still triggering" after it was
 * stopped. The rules now are: a terminal mission (stopped/completed) delivers
 * nothing further, a paused mission delivers only a question that still awaits
 * the owner's answer (a receipt, not a report), and `blocked` — a decision
 * addressed to the owner — keeps its notices.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeWorkers, setup, eventually } from './faults/harness.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** A queued owner row exactly as the runtime records one. */
function queue(f, delivery) {
  f.runtime.store.transaction(() => f.runtime.store.put('deliveries', {
    id: delivery.id, missionId: f.mission.id, from: 'runtime', to: 'owner',
    kind: delivery.kind ?? 'control', content: delivery.content, createdAt: Date.now(),
    ...(delivery.replyExpected === undefined ? {} : { replyExpected: delivery.replyExpected, state: 'open' }),
  }))
}

const delivered = (f, id) => f.runtime.store.get('deliveries', id).deliveredAt !== undefined
const handedToOwner = (f, content) => f.workers.deliveries.some(item => item.memberId === 'owner' && item.content === content)

test('OWNER QUIET: a stopped mission delivers nothing it queued before the stop', async () => {
  const f = await setup({ workers: new FakeWorkers(), config: { tickMs: 10 } })
  try {
    f.propose()
    f.runtime.control(f.owner, f.mission.id, 'stop', 'owner stopped it')
    queue(f, { id: 'msg_quiet_stopped', content: 'decision queued while out of play' })
    f.runtime.pumpOutbox()
    await sleep(150)
    assert.equal(delivered(f, 'msg_quiet_stopped'), false, 'a terminal mission never back-fills its queue to the owner')
    assert.equal(handedToOwner(f, 'decision queued while out of play'), false, 'and the adapter is never asked to deliver it')
  } finally { await f.cleanup() }
})

test('OWNER QUIET: automatic completion does not swallow the facts it raced', async () => {
  // Completion is automatic, so a notice produced while the mission was still
  // running can reach the pump after the mission row already reads `completed`.
  // Keying the rule on the owner's decision rather than on a terminal status is
  // what keeps that fact from being lost; the completion notice itself is
  // written after the transition and must land too.
  const f = await setup({ workers: new FakeWorkers(), config: { tickMs: 10 } })
  try {
    const mission = f.runtime.mission(f.mission.id)
    mission.status = 'completed'
    f.runtime.store.put('missions', mission)
    queue(f, { id: 'msg_quiet_completed', content: 'a fact produced while the mission was still running' })
    f.runtime.pumpOutbox()
    await eventually(() => delivered(f, 'msg_quiet_completed') ? true : undefined,
      'a completed mission still delivers the facts the pump reached after the transition', 4_000)
    assert.equal(handedToOwner(f, 'a fact produced while the mission was still running'), true, 'and the owner session receives it')
  } finally { await f.cleanup() }
})

test('OWNER QUIET: a paused mission keeps a question that still needs an answer and holds its reports', async () => {
  const f = await setup({ workers: new FakeWorkers(), config: { tickMs: 10 } })
  try {
    f.runtime.control(f.owner, f.mission.id, 'pause', 'owner stepped away')
    queue(f, { id: 'msg_quiet_question', kind: 'question', replyExpected: true, content: 'which scope did you mean?' })
    queue(f, { id: 'msg_quiet_report', content: 'a report nobody can act on while paused' })
    f.runtime.pumpOutbox()
    await eventually(() => delivered(f, 'msg_quiet_question') ? true : undefined,
      'a question awaiting the owner must survive a pause: it is a receipt', 4_000)
    assert.equal(handedToOwner(f, 'which scope did you mean?'), true, 'the question reaches the owner session')
    assert.equal(delivered(f, 'msg_quiet_report'), false, 'a paused mission holds its reports instead of waking the owner')
    assert.equal(handedToOwner(f, 'a report nobody can act on while paused'), false, 'and the adapter is not asked for them')
  } finally { await f.cleanup() }
})

test('OWNER QUIET: a blocked mission is a decision addressed to the owner and still speaks', async () => {
  const f = await setup({ workers: new FakeWorkers(), config: { tickMs: 10 } })
  try {
    const mission = f.runtime.mission(f.mission.id)
    mission.status = 'blocked'
    f.runtime.store.put('missions', mission)
    queue(f, { id: 'msg_quiet_blocked', content: 'the mission is blocked and needs a decision' })
    f.runtime.pumpOutbox()
    await eventually(() => delivered(f, 'msg_quiet_blocked') ? true : undefined,
      'a blocked mission must still reach the owner: that is the decision it exists to ask for', 4_000)
  } finally { await f.cleanup() }
})
