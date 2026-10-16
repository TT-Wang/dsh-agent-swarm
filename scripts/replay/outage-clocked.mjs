/**
 * A provider outage and counted start failures on a resident member, on the
 * oracle clock (scripts/replay/oracle.mjs runs it as `outage`; it runs only in
 * oracle mode). Its adapter answers `start` as the Harness adapter does: a
 * start of a member whose session is running adopts it and opens nothing (it
 * resolves true); only a start after the session ended opens one. Every other
 * scenario's adapter opens a session on each start, so this is the one log in
 * which an adopting start and an opening start differ (`recordStarted`).
 *
 *  1. The author holds running work; its adapter reports a rate-limit outage
 *     three times while it retries the preserved attempt in place, scheduling
 *     passes between the reports. Each pass adopts the running session, so no
 *     recovery is recorded and the outage stays on the member.
 *  2. The session ends. The next pass opens it, which records the route as
 *     recovered and clears the outage.
 *  3. The author's start fails once (a counted failure); the next pass adopts
 *     the running session, which ends the count, so the failure after it is
 *     counted from one.
 */
import assert from 'node:assert/strict'
import { FakeWorkers, events, runScenario, setup, wait } from '../../tests/faults/harness.mjs'

if (process.env.SWARM_ORACLE === undefined) throw new Error('outage-clocked runs only under scripts/replay/oracle.mjs (SWARM_ORACLE)')

/** One native session per member: a start adopts a running one or opens one; a stop or `end` closes it. */
class SessionWorkers extends FakeWorkers {
  sessions = new Set()
  /** Members whose next start throws. */
  startFaults = new Set()
  async start(spec) {
    this.started.push(spec.member.id)
    if (this.startFaults.delete(spec.member.id)) throw Object.assign(new Error('worker start failed'), { code: 'EMFILE' })
    const adopted = this.sessions.has(spec.member.id)
    this.sessions.add(spec.member.id)
    return adopted
  }
  async stop(id) { this.stopped.push(id); this.sessions.delete(id) }
  end(id) { this.sessions.delete(id) }
}

await runScenario({
  id: 'outage', title: 'Clocked: an adopting start records no recovery and ends the counted start failures; only an opening start clears the outage', invariants: [],
  body: async () => {
    const workers = new SessionWorkers()
    const f = await setup({ workers })
    try {
      const kinds = type => events(f.runtime, f.mission.id, type)
      const author = () => f.runtime.store.get('members', f.author.id)
      const startsOfAuthor = () => workers.started.filter(id => id === f.author.id).length
      const work = f.propose({ title: 'Running work' })
      const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, work.id)

      const before = startsOfAuthor()
      for (let report = 0; report < 3; report++) {
        workers.callbacks.providerOutage(f.author.id, { class: 'rate-limit', status: 429, message: `Rate limit reached for requests. Request id: req_${report}` })
        await wait(20)
      }
      assert.ok(startsOfAuthor() - before >= 3, 'each pass started the author, adopting its running session')
      assert.deepEqual([kinds('provider/outage').length, kinds('provider/recovered').length], [1, 0], 'an adoption records no recovery')
      assert.equal(author().providerOutage?.class, 'rate-limit', 'the outage stays recorded on the member')
      assert.equal(f.runtime.store.get('tasks', work.id).attempt?.id, claimed.attempt.id, 'on the same preserved attempt')

      workers.end(f.author.id)
      await wait(20)
      assert.deepEqual([kinds('provider/recovered').map(event => event.data.memberId), author().providerOutage], [[f.author.id], undefined], 'the opening start records the recovery and clears the outage')

      workers.startFaults.add(f.author.id)
      await wait(20)
      assert.deepEqual(kinds('member/resume-failed').map(event => event.data.consecutiveFailures), [1], 'the start failure is counted')
      assert.equal(author().startFailures, undefined, 'the adopting start after it ended the count')
      workers.startFaults.add(f.author.id)
      await wait(20)
      assert.deepEqual(kinds('member/resume-failed').map(event => event.data.consecutiveFailures), [1, 1], 'the failure after the adoption is the first of a new run')
      return { adoptingStarts: startsOfAuthor() - before, recovered: kinds('provider/recovered').length }
    } finally { await f.cleanup() }
  },
})
