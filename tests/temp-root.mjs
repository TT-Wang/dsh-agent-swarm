/**
 * R15-F3: a checkout-safe temp root for the fixtures the declared check runs.
 *
 * The host check runner executes each check inside a workspace-write sandbox
 * rooted at the disposable checkout, but TMPDIR/TMP/TEMP stay inherited from the
 * caller — and in the verification runner that is a path outside the sandbox, so
 * every `os.tmpdir()` fixture dies with EPERM before it runs. The declared check
 * string cannot change after admission, so the substitution belongs here:
 * `mkdtemp` under the ambient temp root first, and only when the environment
 * denies it, under `<cwd>/.swarm/test-tmp` (`.swarm/` is git-ignored, so a
 * self-run leaves no untracked path behind).
 *
 * Every assertion, count, timeout and cleanup in the suites is unchanged; only
 * the root of the fixture directory differs.
 */
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Checkout-local fallback root; git-ignored, so it cannot trip [workspace_uncommitted]. */
const fallbackRoot = join(process.cwd(), '.swarm', 'test-tmp')

/** One fixture directory: the ambient temp root, or the checkout-local fallback when denied. */
export async function tempDirectory(prefix) {
  try {
    return await mkdtemp(join(tmpdir(), prefix))
  } catch {
    // The ambient temp root is unusable in this environment (EPERM/EACCES under
    // the check sandbox, ENOENT for a missing TMPDIR, ENOTDIR for a file path).
    // The checkout-local root is the sandbox-safe answer; a prefix we control
    // cannot fail here for any other reason.
    await mkdir(fallbackRoot, { recursive: true })
    return await mkdtemp(join(fallbackRoot, prefix))
  }
}
