# Validation

Version **0.5.0** was validated on 2026-09-08. Supported Harness releases remain prereleases; matching a version string alone does not establish compatibility with an arbitrary checkout or profile.

| Check | Result |
| --- | --- |
| TypeScript checking and production build | Passed |
| Behavioral suite | **163/163 passed**, including 21 workspace cases and 9 delivery cases |
| Real Harness Loader composition | Passed: native workers, tools, evidence, acceptance, integration, restart and unload |
| Extracted npm artifact | Passed through the real Loader; 120 packaged files |
| Native CLI profile installation | Passed: isolated offline install, configuration composition and worker lifecycle |
| `0.1.2-rc.1` native command browser | 7 workflow groups passed, including dirty startup and one-click result application |
| `0.1.3-alpha.2` native command browser | The same 7 workflow groups passed with the same JavaScript artifact |
| `0.1.2-rc.1` invalid-plan recovery browser | 9 workflow groups passed, including same-request repair and result application |
| `0.1.2-rc.1` full sidebar browser | 12 workflow groups passed, including controls, resizing, 390px layout and cold worker history |

The exact Harness revisions were:

- `0.1.2-rc.1`: `a66e4702047846cdaa10c66c9d3df3951f5ea70d`.
- `0.1.3-alpha.2`: `82a5fd61a7cf5c293cec4bdff68f455398d685e9`.

The tested artifact contains 37 JavaScript files. Its SHA-256, computed from sorted `lib`-relative `.js` paths, a NUL separator and file contents, is:

```text
0eaa63c275795ee782763e675a526ca913996e25244a01694c2e0b1fd84d3b08
```

This excludes source maps, package metadata and documentation. The current browser checks exercise the dock fallback; Better Sidebar's public service contract was additionally validated on the prior 0.4.0 release, and that registration path was not changed in 0.5.0.

## Snapshot and delivery evidence

The native browser workflow starts with a staged modification and an untracked user file. It submits one `/agent-swarm` command, verifies that the snapshot includes both files, runs actual worker tools and independently accepts the integration artifact. It then edits the original project again, previews only the snapshot-to-result delta and clicks **Apply result**. Assertions verify the resulting code, preservation of the later edit, and byte-for-byte preservation of the real Git index and the original HEAD.

Workspace tests cover tracked/untracked/deleted files, ignored staged additions, executable bits, symlinks, binary files, concurrent edits, cancellation, interrupted publication, shared baselines, cold recovery, legacy manifests and metadata inventories larger than the ordinary command output cap. Delivery tests cover three-way merging, complete conflict preflight, unrelated histories, repeat application, binary conflicts, path confinement, concurrent edits and cancellation rollback. Race tests use deterministic barriers around real filesystem operations.

Provider responses in integration workflows were **scripted**. Harness, browser authentication, tools, persistence, Git and filesystem effects were real. These results establish integration behavior, not a real model's planning success rate or a comparative swarm benchmark. No paid provider run was added for this change.

## Reproduce

Use a built checkout of an exact revision in [compatibility.json](../compatibility.json). Set `DSH_HARNESS_ROOT` before linking and verification as described in the [README](../README.md).

```sh
npm run link:dsh
npm run typecheck
npm test
npm run test:harness
npm run test:pack
npm run test:profile
npm run test:web
npm run test:command-web
npm run test:validation-repair-web
```

Browser checks need the matching Harness Web build and Playwright browser environment. Set `DSH_WEB_SMOKE_ARTIFACTS` to retain separate browser evidence directories for different host versions. Test profiles and repositories are isolated. Optional `test:deepseek` and `test:command-deepseek` scripts use real provider credentials and are separate, billable checks.

Raw local logs, traces, screenshots, credentials and preview state are excluded from the public repository. Remaining operational boundaries are in [known-limitations.md](known-limitations.md).
