/**
 * CORE-04 test support: the birth every lock test compares, chosen by the
 * platform the suite runs on, never by what the code under test returns.
 *
 * `src/process-identity.ts` reads a process birth on Linux (boot id and start
 * time) and macOS (`ps -o lstart`). A test that skipped whenever `ownBirth()`
 * came back undefined would skip, and stay green, exactly when that read
 * breaks, so the recycled-PID takeover of both locks could be switched off
 * without a failure. On those two platforms a missing or malformed birth is a
 * regression and fails here; only on any other platform is there no birth to
 * compare, and the caller skips.
 */
import assert from 'node:assert/strict'
import { ownBirth } from '../lib/process-identity.js'

/** The format of a birth on each platform that has one, pinned independently of the module that reads it. */
const BIRTH_FORMATS = {
  linux: /^linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/,
  darwin: /^darwin:(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/,
}

/** Why a lock test that needs a birth skips on this platform, or undefined where it must run. */
export const NO_BIRTH = Object.hasOwn(BIRTH_FORMATS, process.platform) ? undefined
  : `${process.platform} has no process birth to compare; the conservative refusal is covered`

/**
 * This process's birth, asserted present and well formed on every platform
 * that has one. Undefined only where `NO_BIRTH` says why.
 */
export function establishedBirth() {
  if (NO_BIRTH !== undefined) return undefined
  const birth = ownBirth()
  assert.equal(typeof birth, 'string', `ownBirth() must establish this process's birth on ${process.platform}`)
  assert.match(birth, BIRTH_FORMATS[process.platform], `ownBirth() must read a ${process.platform} birth`)
  return birth
}

/** A valid birth for this platform that is not `birth`: the same PID recycled by a process born at another time. */
export function recycledBirth(birth) {
  return birth.startsWith('linux:') ? birth.replace(/:\d+$/, ':0') : birth.replace(/\d{4}$/, '1900')
}
