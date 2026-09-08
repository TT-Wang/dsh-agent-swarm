# Validation

Version **0.4.0** was validated on 2026-09-08 against two exact DeepSeek Harness release revisions. Both Harness versions are prereleases; support for other revisions is not implied by a matching version string.

| Harness | Release commit | Build | Behavioral tests | Packed artifact and CLI profile | Native command browser |
| --- | --- | --- | --- | --- | --- |
| `0.1.2-rc.1` | `a66e4702047846cdaa10c66c9d3df3951f5ea70d` | Passed | 145/145 | Passed | 8 workflow groups passed |
| `0.1.3-alpha.2` | `82a5fd61a7cf5c293cec4bdff68f455398d685e9` | Passed | 145/145 | Passed | 8 workflow groups passed |

The builds used separate dependency trees and produced 34 byte-identical JavaScript files. The canonical JavaScript SHA-256 was:

```text
c5bafd45b2313fee7e5f2a782e7fa7b37bfcd59186660f14cf7f714f3413fb72
```

This hashes sorted `lib`-relative `.js` paths, a NUL separator after each path, and each file's bytes. It excludes source maps, package metadata and documentation. Later publication edits changed documentation and package metadata, not runtime JavaScript.

## What the checks cover

- **Native lifecycle:** actual Harness Agent handles, inboxes, session persistence, model-selection state, plugin load/unload, peer-message recovery and cold restart without an active owner.
- **Collaboration:** worker proposals, scoped tools, recorded evidence, independent verification of immutable Git artifacts, integration, accepted completion and stale-attempt rejection.
- **Installation:** an extracted npm tarball loaded through the real Harness Loader; a separate temporary CLI profile installed the local plugin, composed its configuration and repeated the collaboration/recovery workflow.
- **One-command workflow:** native `/agent-swarm` discovery, a single natural-language send, deliberately invalid model-generated scope/checks, correction on the same request, automatic worker launch, real tool execution and independent acceptance. Budgets and acceptance criteria remain those chosen by the primary agent.
- **Browser authentication:** unauthenticated HTTP 401, native launch-token exchange, HttpOnly cookie, redirect to a clean URL and authenticated HTTP 200. Host tests also check hostile-origin rejection and session ownership.
- **Sidebar:** alpha.2 passed 12 full-browser workflow groups covering dock geometry, resizing/collapse, unsaved edits, model/reasoning selection, Pause/Resume/Stop, live worker navigation, cold transcripts, and a 390-pixel viewport. Desktop and mobile screenshots were inspected. The rc.1 full-sidebar run preceded the final persistence helper; its final build was covered by the native host tests and command-browser workflow above.
- **Optional Better Sidebar integration:** the installed service contract passed eight checks on each host. This is not a claim that every other plugin or complete user profile was tested.

The 33 host/Web and 21 client focused checks are included in the 145 behavioral tests, not additional independent totals.

Provider responses in these integration workflows were **scripted**. Harness, browser, authentication, tools, persistence, Git and filesystem effects were real. These results establish integration behavior, not a real model's planning success rate or a comparative swarm benchmark. No paid model run was added for the compatibility migration.

## Reproduce

Use a built checkout of one exact revision in [compatibility.json](../compatibility.json), with its own dependencies installed. Set `DSH_HARNESS_ROOT` before both linking and verification, as described in the [README](../README.md).

```sh
npm run link:dsh
npm run typecheck
npm test
npm run test:harness
npm run test:pack
npm run test:profile
npm run test:web
npm run test:validation-repair-web
```

Browser checks need the matching Harness Web build and Playwright browser environment. Test profiles, repositories and storage are isolated; provider replies are supplied by test fixtures. The optional `test:deepseek` and `test:command-deepseek` scripts use real provider credentials and are separate, billable checks.

Raw local logs, session traces, screenshots, environment files and preview state are deliberately excluded from the public repository. Running the checks produces local evidence under `artifacts/`; the behavioral cases and integration fixtures are included in source. Known unresolved behavior is listed in [known-limitations.md](known-limitations.md).
