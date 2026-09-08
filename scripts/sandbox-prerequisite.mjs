/** Nested-sandbox prerequisite for the real-Harness smoke checks.
 *
 * The Harness composition fixture requests `workspace-write`
 * (`tests/fixtures/built-harness.mjs`), so `test:harness`, `test:pack` and
 * `test:profile` all need the host to permit nested `sandbox_apply`. When this
 * process already runs inside an outer workspace-write sandbox, macOS denies
 * the nested sandbox and every composition fails with SandboxUnavailableError
 * (`sandbox-exec: sandbox_apply: Operation not permitted`). That is a host
 * prerequisite, not a product defect, so the smokes probe it up front and abort
 * with the prerequisite instead of a misleading composition failure.
 *
 * Set DSH_SWARM_SKIP_SANDBOX_PREFLIGHT=1 to skip the probe and attempt the
 * composition anyway.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export const SANDBOX_PREREQUISITE_MESSAGE = [
  'Nested Harness sandboxing is unavailable on this host.',
  'The real-Harness smoke checks compose a profile whose sandbox requests workspace-write; macOS denies',
  'sandbox_apply when this process already runs inside an outer workspace-write sandbox, and the composition',
  'then fails with SandboxUnavailableError ("sandbox-exec: sandbox_apply: Operation not permitted").',
  'Run the check from a terminal that permits nested sandboxing, or set',
  'DSH_SWARM_SKIP_SANDBOX_PREFLIGHT=1 to attempt the composition anyway.',
].join('\n')

export function sandboxPreflightDisabled() {
  return process.env.DSH_SWARM_SKIP_SANDBOX_PREFLIGHT === '1'
}

/** Probe whether this process can apply a nested macOS sandbox profile. */
export async function probeNestedSandbox() {
  if (sandboxPreflightDisabled()) return { usable: true, skipped: true, reason: 'DSH_SWARM_SKIP_SANDBOX_PREFLIGHT=1' }
  if (process.platform !== 'darwin') return { usable: true, skipped: true, reason: 'probe is macOS-only' }
  try {
    await execute('sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { timeout: 10_000 })
    return { usable: true }
  } catch (error) {
    if (error.code === 'ENOENT') return { usable: true, skipped: true, reason: 'sandbox-exec is not installed' }
    const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message ?? ''}`
    if (/sandbox_apply/.test(output) && /Operation not permitted/.test(output)) return { usable: false, output }
    // An unexpected probe failure is inconclusive: do not block a check that may still pass.
    return { usable: true, inconclusive: true, output }
  }
}

/** Abort with the explicit prerequisite when the nested sandbox probe fails. */
export async function assertSandboxPrerequisite(check) {
  const probe = await probeNestedSandbox()
  if (probe.usable) {
    if (probe.skipped) process.stdout.write(`Sandbox preflight skipped for ${check} (${probe.reason}).\n`)
    return probe
  }
  throw new Error(`${check} cannot run here.\n${SANDBOX_PREREQUISITE_MESSAGE}\nProbe output: ${probe.output.trim()}`)
}
