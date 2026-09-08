# Validation

Version **0.6.0** was checked on 2026-09-08. The full regression baseline and the final watch-lifecycle correction are recorded separately below. Supported Harness releases remain prereleases; matching a version string alone does not establish compatibility with an arbitrary checkout or profile.

| Harness release | Exact source commit |
| --- | --- |
| `0.1.2-rc.1` | `a66e4702047846cdaa10c66c9d3df3951f5ea70d` |
| `0.1.3-alpha.2` | `82a5fd61a7cf5c293cec4bdff68f455398d685e9` |

Both targets use isolated SDK links. The rc.1 copy runs the same emitted JavaScript against rc.1 dependencies and its actual CLI; it is not an alpha.2-linked plugin with only a different CLI environment variable. Host and client TypeScript are also checked against the selected SDK without re-emitting that copy.

## Current revision baseline (2026-09-09)

Measured on the integrated remediation of revision `a226108` (the `dec5fe7` feature head plus `scripts/update-preview.mjs`) after assembling the six accepted implementation artifacts — runtime `3c470f7d`, capture `6e911c7c`, surface `87b5bdbd`, adapter `66ae0f4c`, client `11d56f61`, packaging `66bdafdb` — and the integration hand-offs. The digest algorithm documented below reproduces the recorded `1c58738` baseline digest `008061c3b73adcf4c82b4e710735d11f060999a1c602e4851897468d173b8ea3` (43 files), so the current digest is computed the same way. The emitted set grows by one file versus `a226108` because the client remediation adds `src/client/clock.ts`.

| Check | Result on this revision |
| --- | --- |
| Host/client TypeScript and production browser build | Passed (`npm run build`) |
| Emitted JavaScript | 44 files, SHA-256 `3c3993abf7dc812e051b13227ddc53c46a1de9bd265e40d16eafc7850389aa78` |
| Complete behavioral suite (`node --test tests/*.test.mjs`) | **281/281 passed**, 0 failed, 0 skipped |
| Clean pack manifest (`npm pack --dry-run --json` with lifecycle scripts) | `files=141`; `lib/index.js` and `lib/client.js` both present (H5) |
| `npm run test:pack` | Stopped at the nested-sandbox prerequisite on this host (below); its clean-checkout `prepack` assertions are exercised on a host that permits nested `sandbox_apply` |
| `npm run test:profile` | Not re-run in this integration; it composes the same real-Harness fixture |
| `npm run test:web` / `npm run test:command-web` | Not re-run in this integration; they must be run sequentially on an idle host (see below) |

The two sections that follow record the historical 0.6.0 release baseline and final watch-lifecycle correction. They are retained as first-baseline evidence and are not re-digested against later revisions. Recompute this table whenever source changes land after the measurement above: the digest covers emitted `lib/` output and the behavioral count covers the full test suite.

## Full regression baseline

The first 0.6.0 build contained 42 JavaScript files, with SHA-256:

```text
fac66e2d358725fee2ffe822f26f42fa4f4a2290de802aba48b2cbfb01126bc1
```

| Check | Result on this baseline |
| --- | --- |
| Host/client TypeScript and production browser build | Passed |
| Complete alpha.2 behavioral suite | **192/192 passed** |
| Complete isolated rc.1 behavioral suite | **192/192 passed** |
| Alpha.2 real Harness Loader composition | Passed |
| Rc.1 real Harness Loader composition | Passed on an unchanged retry after the timeout described below |
| Alpha.2 extracted npm artifact | Passed through the real Loader; 135 packaged files |
| Alpha.2 native CLI profile installation | Passed: isolated install, configuration composition and worker lifecycle |
| Alpha.2 native command browser | **10 workflow groups passed** |
| Alpha.2 full sidebar browser | **13 workflow groups passed** |
| Alpha.2 invalid-plan recovery browser | **12 workflow groups passed** |

The first rc.1 Loader run exceeded a fixture's five-second tool timeout during heavy machine load. That run is retained as a failure, not counted as a pass. An unchanged retry passed on the same baseline hash. Final-artifact Loader checks, when listed below, are separate runs.

## Final watch-lifecycle correction

Review found that native owner creation/disposal can change `ownerLive` without changing the swarm database revision. The final correction wakes an outstanding watch on those native lifecycle events and refreshes ownership/connection metadata in keepalive responses, while preserving unchanged mission data.

The final 42-file JavaScript artifact has SHA-256:

```text
3feb18ce3020c002d0b7b9d8356872226b628b178498b3bc44f6381494d9e94d
```

| Check | Result on the final artifact |
| --- | --- |
| Production build and isolated rc.1 host/client typechecking | Passed; rc.1 reused the emitted artifact without rebuilding it |
| Alpha.2 live-state and native Web API regressions | **25/25 passed**, including two new lifecycle/metadata cases |
| Live provider connection through the installed alpha.2 preview | Passed: native session creation, prompt and follow returned the expected fixed response |
| Isolated rc.1 live-state and native Web API regressions | **25/25 passed** |
| Isolated rc.1 Loader, packaged artifact and CLI installation | Passed: real Loader, 135 packaged files, offline install and installed-bundle composition |
| Final alpha.2 native command browser | **10 workflow groups passed**, including activity, watch recovery, hidden-pane catch-up and result application |

The complete 192-test suite was run on the baseline, then the affected live-state/Web API tests were run again after the narrow correction. Lifecycle fixtures now wait for actual session flushing, watch subscription and native-call readiness instead of fixed sleeps. Final rc.1 Loader attempts also exceeded a fixture's five-second verification deadline; its test-only allowance was raised to 30 seconds, retaining all verification assertions and the mission deadline. These fixture corrections did not change the final product artifact. The final focused suite includes two added cases; this is not a claim that a complete 194-test suite was rerun on the final hash. The baseline sidebar and invalid-plan browser evidence is likewise not relabeled as final-hash evidence.

Final browser verification used alpha.2. Rc.1 was verified through its isolated typechecking, focused regressions, Loader, extracted package and native CLI profile; a separate rc.1 browser run was not repeated for 0.6.0.

Digests above concatenate sorted `lib`-relative `.js` paths, a NUL separator and file contents. Source maps, package metadata and documentation are excluded.

## What the workflows exercise

The native command browser submits one `/agent-swarm` goal. Its initial and running views have no visible manual budget fields or four-tab technical bar. A real native model stream waits at the fixture's model-only gate while the panel displays **Agent is thinking** and an elapsed clock tied to that operation's actual start. The test hides the sidebar, lets actual workers finish independent verification, confirms the hidden panel stops issuing state/watch requests, then reopens it and checks the completed state under the same owner. A deliberately failed watch exposes **Reconnecting**; the next successful watch restores the state and keeps the selected owner.

The same workflow starts from staged and untracked source edits. It checks that one frozen project snapshot includes both, runs actual worker tools, accepts the integration artifact independently, and then edits the source again. **View changes** presents only the snapshot-to-result delta. **Apply result** changes the requested code while preserving the later source edit, the real Git index byte for byte and the original HEAD. The invalid-plan variant additionally rejects missing code checks and invalid scopes, then repairs the original request without partial workers, a duplicate mission or changed acceptance/budget decisions.

The full sidebar browser opens the advanced editor explicitly, saves a native model/reasoning choice, and checks resizing plus unsaved draft retention across collapse/reopen. It exercises Pause/Resume, native live-worker navigation, owner-only controls, Stop confirmation, the technical graph disclosure, a 390-pixel viewport and cold transcripts containing actual host tool output without another model request. Recorded screenshots of thinking, reconnecting, applied results and the responsive layout were visually inspected.

Activity and runtime regressions cover native model/tool operation boundaries, provider retry backoff, cancellation, long-operation renewal, ordinary expiry without a live adapter operation, pause, restart and deadline cancellation while the mission queue is occupied. Store/watch tests cover transaction-only revision changes, rollback, bounded replay, cancellation, owner isolation, mission delta merging, native owner lifecycle and metadata updates without an invented database revision.

## Timing and evidence boundaries

The watch protocol removes a fixed two-second polling wait; it does not promise a latency bound under arbitrary host/browser/network load. The final browser timing method samples each previously unseen mission/event sequence once, only in a delta returned to a continuous observer. Full snapshots, eventless lease updates and the first reply after interruption are excluded. Earlier raw reports sampled the age of the last event even for eventless deltas; those values include idle time and are not treated as delivery latency.

The final alpha.2 command run recorded **11 eligible event samples at 22–235 ms** from host event creation to browser observation. That one local scripted scenario took 89.2 seconds overall, including startup and an intentional reconnect wait, with 14 model-fixture requests and eight real tool calls. These measurements demonstrate event-driven delivery in that run, not a general performance benchmark or service guarantee.

Provider responses in the regression suites were **scripted**. Harness, browser authentication, tools, persistence, Git and filesystem effects were real. These results establish integration behavior, not a real model's planning success rate or a comparative swarm benchmark. The regression suites did not make billable model requests.

A separate minimal live connection check used the installed final artifact and native Harness session creation, prompt and follow APIs with `deepseek-official/deepseek-v4-flash`. It returned the expected fixed response, and the authenticated plugin state recognized the live owner. That check requested no tools and created no swarm mission; it verifies provider connectivity through Harness, not full real-provider swarm planning or acceptance.

Browser checks exercise the dock fallback; Better Sidebar's public service contract was validated separately on the earlier release, and its registration path is unchanged here.

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

Browser checks need the matching Harness Web build and Playwright browser environment. Set `DSH_WEB_SMOKE_ARTIFACTS` to retain separate evidence directories for different host versions. Test profiles and repositories are isolated. Running the large Harness suites and multiple browsers concurrently can increase load enough to exceed small fixture timeouts; run them sequentially when reproducing. Optional `test:deepseek` and `test:command-deepseek` scripts use real provider credentials and are separate, billable checks.

The behavioral tests import the built `lib/` output. `npm test` builds first; a bare `node --test tests/*.test.mjs` needs `npm run link:dsh` and `npm run build` first, otherwise it stops at `ERR_MODULE_NOT_FOUND .../lib/runtime.js`. A clean checkout without linked dependencies stops earlier at `tsc: command not found`.

`npm run test:harness`, `npm run test:pack` and `npm run test:profile` compose a real Harness profile whose sandbox requests `workspace-write`, so they require a host that permits nested `sandbox_apply`. Inside an outer workspace-write sandbox, macOS denies it (`sandbox-exec: sandbox_apply: Operation not permitted`) and the composition fails with `SandboxUnavailableError`. `test:pack` and `test:profile` detect an unusable nested sandbox before the composition and abort with that prerequisite; set `DSH_SWARM_SKIP_SANDBOX_PREFLIGHT=1` to attempt the composition anyway. `npm run test:harness` runs the composition directly and reports the same `SandboxUnavailableError`.

`npm run test:web` and `npm run test:command-web` launch the real Web application and are load-sensitive. Run them sequentially on an idle host, without other large suites or browsers in parallel, and re-run a timeout before treating it as a product defect.

Raw local logs, traces, screenshots, credentials and preview state are excluded from the public repository. Remaining operational boundaries are in [known-limitations.md](known-limitations.md).
