/** F3b: provider omission/truncation. Fault verified as fired; the truncated call is rejected before any retry. */
import assert from 'node:assert/strict'
import { runProviderFault } from './provider-fixture.mjs'
import { eventually } from './harness.mjs'

await runProviderFault({
  id: 'F3b', title: 'A truncated provider stream is detected and the corrupted call is rejected', mode: 'omitted-finish',
  fault: () => ({ kind: 'fault-omit', name: 'swarm_observe', argumentsDelta: '{"missionId":"mission_broken' }),
  assertFault: async fixture => {
    const call = await eventually(() => fixture.sessionEvents.find(event => event.type === 'call' && event.name === 'swarm_observe'), 'the truncated call reaches the tool boundary', 15_000)
    assert.match(call.arguments, /mission_broken/, 'the truncated arguments are the injected fault')
    const result = await eventually(() => fixture.sessionEvents.find(event => event.type === 'result'), 'the truncated call produces a result', 15_000)
    assert.equal(result.isError, true, 'I12: the corrupted call is never executed as valid')
    assert.match(result.text, /Expected an object/, 'the rejection is attributed to the malformed arguments')
    assert.equal(fixture.runtime.store.get('missions', 'mission_broken'), undefined, 'the truncated identity never resolves to a real mission')
  },
})
