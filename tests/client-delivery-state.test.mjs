import assert from 'node:assert/strict'
import test from 'node:test'
import { uiSnapshot } from './fixtures/ui-snapshot.mjs'
import { checkDeliveryOutcome, projectDeliveryState } from '../lib/types/client/delivery-state.js'

const commit = 'a'.repeat(40)
const conflictResult = { status: 'conflicts', changedPaths: ['src/search.ts'], conflicts: ['src/search.ts'] }
function snapshot() {
  return { ...uiSnapshot(), completion: { eligible: true }, deliveryTarget: { taskId: 't2', commit } }
}
function withConflict(base, seq = 10) {
  const latest = structuredClone(base)
  delete latest.appliedDelivery
  latest.events.push({ seq, missionId: latest.mission.id, type: 'delivery/conflicts', actor: 'owner', createdAt: latest.mission.updatedAt + seq,
    data: { resultCommit: commit, ...conflictResult } })
  return latest
}

test('new host state supersedes a successful local response, including a cleared applied receipt', () => {
  const base = snapshot(), applied = { ...base, appliedDelivery: { resultCommit: commit, appliedAt: base.mission.updatedAt } }
  const observation = { baseSnapshot: base, commit, snapshot: applied, result: { status: 'applied', changedPaths: ['src/search.ts'], conflicts: [] } }
  assert.deepEqual(projectDeliveryState(base, commit, observation), { applied: true })
  const current = withConflict(applied)
  assert.deepEqual(projectDeliveryState(current, commit, observation), { applied: false, result: conflictResult })
  const cleared = snapshot()
  assert.deepEqual(projectDeliveryState(cleared, commit, observation), { applied: false }, 'clearing is authoritative even after the event window scrolls')
})

test('legacy mutation response is provisional only until a newer snapshot arrives', () => {
  const base = snapshot(), observation = { baseSnapshot: base, commit, result: { status: 'applied', changedPaths: [], conflicts: [] } }
  assert.equal(projectDeliveryState(base, commit, observation).applied, true)
  assert.equal(projectDeliveryState(structuredClone(base), commit, observation).applied, false)
  assert.equal(projectDeliveryState(base, 'b'.repeat(40), observation).applied, false)
})

test('timeout followed by an authoritative negative read enables explicit retry without another mutation', () => {
  const base = snapshot(), checked = checkDeliveryOutcome(base, commit, structuredClone(base))
  assert.equal(checked.kind, 'retry')
  assert.deepEqual(projectDeliveryState(base, commit, checked.observation), { applied: false })
  assert.equal(checkDeliveryOutcome(base, commit).kind, 'missing', 'a failed/missing read must not pretend verification occurred')
  assert.equal(checkDeliveryOutcome(base, commit, { ...base, mission: { ...base.mission, id: 'other' } }).kind, 'missing')
  assert.equal(checkDeliveryOutcome(base, commit, { ...base, deliveryTarget: { taskId: 'next', commit: 'b'.repeat(40) } }).kind, 'missing')
})

test('timeout followed by conflicts restores conflict paths and leaves apply retry available', () => {
  const base = snapshot(), checked = checkDeliveryOutcome(base, commit, withConflict(base))
  assert.equal(checked.kind, 'conflicts')
  assert.deepEqual(projectDeliveryState(base, commit, checked.observation), { applied: false, result: conflictResult })
})

test('timeout followed by a successful receipt prevents duplicate apply and later host conflicts can supersede it', () => {
  const base = snapshot(), applied = { ...base, appliedDelivery: { resultCommit: commit, appliedAt: base.mission.updatedAt } }
  const checked = checkDeliveryOutcome(base, commit, applied)
  assert.equal(checked.kind, 'applied')
  assert.equal(projectDeliveryState(base, commit, checked.observation).applied, true)
  assert.equal(projectDeliveryState(withConflict(applied), commit, checked.observation).applied, false)
})

test('the newest matching delivery outcome wins without replaying old or foreign conflict paths', () => {
  const base = withConflict(snapshot())
  base.events.push({ seq: 11, missionId: base.mission.id, type: 'delivery/applied', actor: 'owner', data: { resultCommit: commit }, createdAt: base.mission.updatedAt + 11 },
    { seq: 12, missionId: 'other', type: 'delivery/conflicts', actor: 'owner', data: { resultCommit: commit, ...conflictResult }, createdAt: base.mission.updatedAt + 12 })
  assert.deepEqual(projectDeliveryState(base, commit), { applied: false }, 'current cleared projection wins over old applied event; old conflicts must not reappear')
  assert.equal(projectDeliveryState(withConflict(base, 13), commit).result.status, 'conflicts')
})
