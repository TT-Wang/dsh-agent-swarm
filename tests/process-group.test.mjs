/** W3: reaping a finished check's process group must never replace its result. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { runProcess } from '../lib/workspaces.js'

async function withRejectedSignalKill(callback) {
  const original = process.kill
  process.kill = () => { const error = new Error('kill EPERM'); error.code = 'EPERM'; throw error }
  try { return await callback() }
  finally { process.kill = original }
}

test('a finished check resolves with its real exit code when group reaping is not permitted', async () => {
  const result = await withRejectedSignalKill(async () => await runProcess(['sh', '-c', 'printf hello; exit 0'], { cwd: process.cwd(), timeoutMs: 10_000, maxBytes: 1024 }))
  assert.equal(result.exitCode, 0)
  assert.match(result.output, /hello/)
})

test('a timed-out check still rejects with its timeout error when the kill is not permitted', async () => {
  await withRejectedSignalKill(async () => {
    await assert.rejects(runProcess(['sh', '-c', 'sleep 5'], { cwd: process.cwd(), timeoutMs: 200, maxBytes: 1024 }), /timed out/)
  })
})
