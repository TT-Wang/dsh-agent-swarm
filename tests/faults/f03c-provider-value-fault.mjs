/** F3c: provider value fault in a tool-call field. Fault verified as fired; the corrupted call is rejected. */
import assert from 'node:assert/strict'
import { runProviderFault } from './provider-fixture.mjs'
import { eventually } from './harness.mjs'

await runProviderFault({
  id: 'F3c', title: 'A corrupted tool-call value is rejected instead of executed as valid', mode: 'corrupt-tool-value',
  fault: state => ({ kind: 'fault-value', name: 'swarm_claim', args: { missionId: 'mission_not_ours', taskId: state.taskId, attemptId: 'bogus-attempt' } }),
  assertFault: async fixture => {
    const call = await eventually(() => fixture.sessionEvents.find(event => event.type === 'call' && event.name === 'swarm_claim'), 'the corrupted call reaches the tool boundary', 15_000)
    assert.match(call.arguments, /mission_not_ours/, 'the corrupted value is the injected fault')
    const result = await eventually(() => fixture.sessionEvents.find(event => event.type === 'result'), 'the corrupted call produces a result', 15_000)
    assert.equal(result.isError, true, 'I12: the corrupted call is never executed as valid')
    assert.match(result.text, /Unknown mission/, 'the rejection is attributed to the corrupted identity')
    assert.equal(fixture.runtime.store.get('missions', 'mission_not_ours'), undefined, 'the corrupted mission identity never exists')
    const task = fixture.runtime.store.get('tasks', fixture.task.id)
    assert.equal(task.attempt.id, fixture.claimed.attempt.id, 'the corrupted call did not fence or re-claim the task')
    assert.equal(task.status, 'running')
  },
})
