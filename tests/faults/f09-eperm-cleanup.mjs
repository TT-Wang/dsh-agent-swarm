/** F9: a child exits with a background descendant and the group kill returns EPERM. The real result is returned. */
import assert from 'node:assert/strict'
import { runProcess, runScenario } from './harness.mjs'
import { subprocessSeam } from '../subprocess-seam.mjs'

await runScenario({
  id: 'F9', title: 'An EPERM process-group cleanup never turns a successful check into a failure', invariants: ['I8'],
  body: async () => {
    const originalKill = process.kill
    let denied = 0
    process.kill = (pid, signal) => {
      if (pid < 0) {
        denied += 1
        const error = new Error('kill EPERM')
        error.code = 'EPERM'
        throw error
      }
      return originalKill(pid, signal)
    }
    try {
      // Injection: the child leaves a background descendant; the range kill the
      // plugin's own release path triggers is denied exactly as under pid/pgid
      // reuse. Since the 2026-09-11 subprocess adoption that kill is issued by
      // the provider behind `ctx.subprocess`, so the denial lands in its kill
      // path; the injection still fires, and this scenario keeps asserting that
      // no cleanup denial reaches the check's result.
      const result = await runProcess(['sh', '-c', 'sleep 1 & echo FOREGROUND_OK; exit 0'], { subprocess: subprocessSeam, cwd: process.cwd(), timeoutMs: 10_000, maxBytes: 4_096 })
      assert.equal(result.exitCode, 0, 'I8: the child’s real exit code is returned')
      assert.match(result.output, /FOREGROUND_OK/, 'I8: the child’s real output is returned')
      assert(denied >= 1, 'the injected group-kill denial fired')
      assert.equal(result.truncated, false)
      // Second injection: a timeout whose kill is denied must still report the timeout.
      await assert.rejects(
        runProcess(['sh', '-c', 'trap "" TERM; sleep 1'], { subprocess: subprocessSeam, cwd: process.cwd(), timeoutMs: 100, maxBytes: 4_096 }),
        error => /timed out after/i.test(error.message) && !/EPERM/.test(error.message),
        'I8: the primary timeout failure is reported, not the cleanup denial',
      )
      assert(denied >= 2, 'the timeout leg also injected a denied group kill')
      return { deniedGroupKills: denied, exitCode: result.exitCode }
    } finally { process.kill = originalKill }
  },
})
