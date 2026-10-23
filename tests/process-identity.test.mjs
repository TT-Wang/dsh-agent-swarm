/**
 * CORE-04: one owner identity for every file lock. The store's runtime lock and
 * the delivery apply lock record `{ pid, birth }` and take a lock over only when
 * `ownerAbandoned` shows its owner gone; these cases pin that rule once, and
 * tests/delivery.test.mjs and tests/r12-store-fixes.test.mjs pin each lock on it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ownBirth, ownerAbandoned, recordedOwner } from '../lib/process-identity.js'
import { NO_BIRTH, establishedBirth, recycledBirth } from './process-birth.mjs'

test('a recorded owner names a signalable PID, keeps a string birth and ignores the lock\'s other fields', () => {
  for (const value of [null, 'owner', [{ pid: 1 }], {}, { pid: 0 }, { pid: -4 }, { pid: 1.5 }, { pid: '42' }, { pid: 2 ** 31 }])
    assert.equal(recordedOwner(value), undefined, JSON.stringify(value))
  assert.deepEqual(recordedOwner({ pid: 2 ** 31 - 1 }), { pid: 2 ** 31 - 1 })
  assert.deepEqual(recordedOwner({ pid: 42, nonce: 'n', createdAt: 1, birth: 'darwin:x' }), { pid: 42, birth: 'darwin:x' })
  assert.deepEqual(recordedOwner({ pid: 42, birth: 7 }), { pid: 42 })
})

test('an owner whose PID no process holds is abandoned, with or without a birth', () => {
  // Above every platform's PID ceiling, so ESRCH on every host.
  assert.equal(ownerAbandoned({ pid: 2 ** 31 - 1 }), true)
  assert.equal(ownerAbandoned({ pid: 2 ** 31 - 1, birth: 'linux:00000000-0000-0000-0000-000000000000:1' }), true)
})

test('a live PID keeps its lock unless its holder was demonstrably born at another time', t => {
  // No identity, or one this build cannot compare, stays conservative.
  assert.equal(ownerAbandoned({ pid: process.pid }), false)
  assert.equal(ownerAbandoned({ pid: process.pid, birth: 'unrecognized-birth' }), false)
  // Linux and macOS always establish a birth; only another platform skips.
  const birth = establishedBirth()
  if (birth === undefined) { t.skip(NO_BIRTH); return }
  assert.equal(ownBirth(), birth, 'a process birth is read once and never changes')
  // The owner's own birth: the same process, so the lock is live.
  assert.equal(ownerAbandoned({ pid: process.pid, birth }), false)
  // The same PID with a different birth on this platform: a recycled PID.
  assert.equal(ownerAbandoned({ pid: process.pid, birth: recycledBirth(birth) }), true)
  // A valid birth from another platform is not comparable, so the live PID keeps the lock.
  const foreign = birth.startsWith('linux:') ? 'darwin:Thu Jan  1 00:00:00 1970' : 'linux:00000000-0000-0000-0000-000000000000:1'
  assert.equal(ownerAbandoned({ pid: process.pid, birth: foreign }), false)
})
