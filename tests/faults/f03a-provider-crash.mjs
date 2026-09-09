/** F3a: provider crash fault on the content field. Fault verified as fired; recovery is per mode; no partial artifact trusted. */
import assert from 'node:assert/strict'
import { runProviderFault } from './provider-fixture.mjs'
import { events, eventually } from './harness.mjs'

await runProviderFault({
  id: 'F3a', title: 'A provider crash on the content field is verified and recovers inside the same attempt', mode: 'crash-content',
  fault: () => ({ kind: 'fault-crash', partial: 'partial content before the crash' }),
  assertFault: async fixture => {
    const failure = await eventually(() => events(fixture.runtime, fixture.mission.id, 'member/failure')[0], 'the provider crash is durably reported', 15_000)
    assert.match(failure.data.error, /injected provider crash on the content field/, 'the recorded failure is the injected fault')
    assert.equal(fixture.sessionEvents.filter(event => event.type === 'call').length, 0, 'the crashed stream executed no tool call')
    assert.equal(fixture.sessionEvents.filter(event => event.type === 'result').length, 0, 'the crashed stream produced no tool result')
  },
})
