/**
 * The managed-process seam (`ctx.subprocess`) this plugin now runs every command
 * through: the Git plumbing on its own worktrees, a worker's shell-syntax probe
 * and every declared check.
 *
 * Production resolves that service from the host (`ctx.get('subprocess')`). These
 * suites have two ways to supply it, and both use the same local provider the
 * base profile mounts:
 *
 *  - a test that composes a Cordis context mounts {@link SubprocessLocal} like
 *    any other plugin, so `ctx.get('subprocess')` resolves exactly as it does in
 *    production;
 *  - a test that constructs `Workspaces`/`runProcess` directly hands over
 *    {@link subprocessSeam}, the resolver form `ProcessSeamSource` describes.
 *
 * Either way the suites exercise the production path — this plugin's argv,
 * environment and output window over the provider's owned process range, its
 * TERM-before-KILL ladder and its quiescence — instead of a second launcher that
 * only tests would ever use.
 */
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The provider plugin a composition mounts, exactly as the base profile does. */
export { default as SubprocessLocal } from '@deepseek-ai/dsh-subprocess-local'

/**
 * The provider creates a private spill directory under the ambient temp root on
 * every spawn — even for the piped stdio this plugin asks for — so a hostile
 * `TMPDIR` fails inside the host process instead of reaching this plugin's own
 * fallbacks. A harness that injects such a root (R15-F5's F8 scenario) therefore
 * hands the provider its own root through the provider's documented test hook.
 * The directory stays empty (this plugin never collects through the provider) and
 * the fixture removes it at process exit, because the provider's own exit-time
 * cleanup only covers the default root it would have created itself.
 */
function spillRoot() {
  const root = process.env.SWARM_FIXTURE_TMP ?? join(fileURLToPath(new URL('..', import.meta.url)), '.swarm', 'test-tmp')
  mkdirSync(root, { recursive: true })
  const directory = mkdtempSync(join(root, 'dsh-subprocess-'))
  process.once('exit', () => { try { rmSync(directory, { recursive: true, force: true }) } catch { /* exit-time best effort */ } })
  return directory
}

let standalone

/** One provider, built on first use so a suite that only composes a host never starts a second one. */
function createProvider() {
  const provider = new LocalSubprocessRuntime(new Context())
  provider.internals.spillDir = spillRoot()
  return provider
}

/** Resolver form (see `ProcessSeamSource`): the seam a suite hands to `Workspaces`/`runProcess`. */
export const subprocessSeam = () => (standalone ??= createProvider())
