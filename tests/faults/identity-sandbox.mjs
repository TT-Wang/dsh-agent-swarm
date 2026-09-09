/**
 * Identity sandbox provider for the fault suite's Loader tier.
 *
 * The gate host refuses `sandbox-exec` (`sandbox_apply: Operation not
 * permitted`), so the real backend cannot confine anything here and the swarm
 * plugin's `sandbox` service would be unusable. This provider substitutes the
 * OS-confinement boundary only: argv passes through unchanged. The
 * provider-fault invariants under test (crash/omission/value recovery) do not
 * depend on OS confinement, and no scenario assertion is weakened by this.
 */
export const name = 'faults-identity-sandbox'

export function apply(ctx) {
  ctx.provide('sandbox', {
    confine(argv) { return { argv, enforcement: 'none' } },
  })
}
