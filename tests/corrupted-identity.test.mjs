/**
 * F3c follow-up: a corrupted identity value in a member tool call is refused as
 * that identity, and nothing runs. F3c (Loader tier) corrupts the missionId of
 * swarm_claim; these cover the two other identities a provider value fault can
 * corrupt: the attemptId of swarm_submit and a taskId that belongs to another
 * mission. Both are driven through the registered tools.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, events, taskOf, budget, MISSION_ACCEPTANCE } from './faults/harness.mjs'
import { registerTools } from '../lib/tools.js'

function toolsOf(f) {
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, f.runtime, budget)
  return (name, args, member) => definitions.get(name).execute(args, { signal: new AbortController().signal, agent: { id: member.sessionId, session: { header: { cwd: f.dir } } } })
}

test('F3c: a corrupted attemptId on swarm_submit is refused as a stale attempt and the attempt keeps running', async () => {
  const f = await setup()
  try {
    const call = toolsOf(f)
    const task = f.propose()
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    await assert.rejects(call('swarm_submit', { missionId: f.mission.id, taskId: task.id, attemptId: 'attempt_corrupted', output: 'done' }, f.author),
      error => /task_attempt_stale/.test(`${error.code} ${error.message}`), 'the refusal names the corrupted attempt identity')
    const current = taskOf(f.runtime, task.id)
    assert.equal(current.status, 'running', 'nothing was submitted')
    assert.equal(current.attempt.id, claimed.attempt.id, 'the real attempt is neither fenced nor replaced')
    assert.equal(current.artifact, undefined)
    assert.equal(events(f.runtime, f.mission.id, 'task/submitted').length, 0)
  } finally { await f.cleanup() }
})

test('F3c: a taskId from another mission is refused as not in this mission and is never claimed', async () => {
  const f = await setup()
  try {
    const call = toolsOf(f)
    const other = f.runtime.create(f.owner, { title: 'Other', objective: 'Another mission of the same owner', workspace: f.dir, scope: ['**'], acceptance: MISSION_ACCEPTANCE, budget })
    const stream = f.runtime.workstream(f.owner, other.id, { title: 'Other', objective: 'Other' })
    const foreign = f.runtime.propose(f.owner, other.id, { outputs: [], workstreamId: stream.id, title: 'Foreign', objective: 'Foreign work',
      kind: 'implementation', scope: ['**'], acceptance: MISSION_ACCEPTANCE, checks: ['test -d .'] })
    await assert.rejects(call('swarm_claim', { missionId: f.mission.id, taskId: foreign.id }, f.reviewer),
      error => /task_not_in_mission/.test(`${error.code} ${error.message}`), 'the refusal names the foreign task identity')
    const current = taskOf(f.runtime, foreign.id)
    assert.equal(current.missionId, other.id)
    assert.equal(current.status, 'pending', 'the foreign task is not claimed')
    assert.equal(current.attempt, undefined, 'no attempt was opened through the wrong mission')
    assert.equal(events(f.runtime, f.mission.id, 'task/claimed').length, 0)
    assert.equal(events(f.runtime, other.id, 'task/claimed').length, 0)
  } finally { await f.cleanup() }
})
