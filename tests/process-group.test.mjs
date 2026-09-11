/**
 * W3 + the subprocess seam: a check's own result survives a denied range-signal
 * path. The plugin no longer signals process groups itself — since the
 * 2026-09-11 adoption, the provider behind `ctx.subprocess` owns the process
 * range, its TERM-before-KILL ladder and its quiescence, and that provider's own
 * suite covers its EPERM/ESRCH tolerance. What this file still owns is the
 * adapter: when every signal the provider issues is denied, the run must resolve
 * with the command's real exit code and output, and a deadline must still report
 * its own timeout instead of a cleanup failure.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { runProcess } from '../lib/workspaces.js'
import { subprocessSeam } from './subprocess-seam.mjs'

/** Deny every signal, positive or negative pid, exactly as a recycled pid/pgid would. */
async function withRejectedSignalKill(callback) {
  const original = process.kill
  process.kill = () => { const error = new Error('kill EPERM'); error.code = 'EPERM'; throw error }
  try { return await callback() }
  finally { process.kill = original }
}

test('a finished check resolves with its real exit code when range signalling is not permitted', async () => {
  const result = await withRejectedSignalKill(async () => await runProcess(['sh', '-c', 'printf hello; exit 0'], { subprocess: subprocessSeam, cwd: process.cwd(), timeoutMs: 10_000, maxBytes: 1024 }))
  assert.equal(result.exitCode, 0)
  assert.match(result.output, /hello/)
})

test('a timed-out check still rejects with its timeout error when the kill is not permitted', async () => {
  await withRejectedSignalKill(async () => {
    await assert.rejects(runProcess(['sh', '-c', 'sleep 5'], { subprocess: subprocessSeam, cwd: process.cwd(), timeoutMs: 200, maxBytes: 1024 }), /timed out/)
  })
})
