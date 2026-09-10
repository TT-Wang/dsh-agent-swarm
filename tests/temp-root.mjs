/**
 * R15-F3 / R15-F5: the checkout-safe temp root the fixtures and production share.
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
 * R15-F5: this module no longer carries its own copy of that ladder. The one
 * implementation is the exported `tempDirectory` in `src/delivery.ts`, which
 * production delivery also uses for its scratch root; re-exporting it here means
 * a fixture and the production path cannot disagree about which roots are tried,
 * or about which errno values fall through.
 *
 * Every assertion, count, timeout and cleanup in the suites is unchanged; only
 * the root of the fixture directory differs.
 */
export { tempDirectory } from '../lib/delivery.js'
