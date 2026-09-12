# Validation

Version **0.6.0** was checked on 2026-09-08. The full regression baseline and the final watch-lifecycle correction are recorded separately below. Supported Harness releases remain prereleases; matching a version string alone does not establish compatibility with an arbitrary checkout or profile.

| Harness release | Exact source commit |
| --- | --- |
| `0.1.5-rc.1` | `183f08e9c6dde7e36cd2318eaee70b0da08fb35e` |
| `0.1.3-alpha.2` | `82a5fd61a7cf5c293cec4bdff68f455398d685e9` |
| `0.1.2-rc.1` | `a66e4702047846cdaa10c66c9d3df3951f5ea70d` |

## 0.1.5-rc.1 baseline (2026-09-11)

The owner pass of 2026-09-11 adapted the plugin to the npm `latest` line and measured it on a checkout
built from the release tag `dsh-v0.1.5-rc.1` (`183f08e9c6`): `pnpm install --frozen-lockfile` (25 s) then
`build:lib`, `build:native-system` and `build:web` in a fresh clone of that revision. The project's
Harness symlink farm was repointed at that checkout for the run (the tracked linker still enforces
`compatibility.json`), then restored.

| Check | 0.1.5-rc.1 (`183f08e9c6`) | 0.1.3-alpha.2 (`82a5fd61a7`) |
| --- | --- | --- |
| `npm run build` | exit 0 | exit 0 |
| `node --test tests/*.test.mjs` | **833/833** | **833/833** |
| `npm run test:faults` | **24/24** | **24/24** |
| `npm run test:replay` | `REPLAY OK`, digest `sha256:61a921e64088b78b957cd6aeaa563d5436d4a6eae4b0130725d1f3c74c6f971e` | identical digest |
| `npm run test:harness` (real Loader composition) | passed | passed |
| `npm run test:profile` (installed bundle through the real CLI) | passed | passed |
| `npm run test:pack` (packed artifact) | passed (187 published files) | passed |
| `npm run test:bundle` | 7/7 | 7/7 |

Three product changes make the newest line work, and each is written to satisfy every supported
release rather than forked by version: the worker setup hook accepts the agent as an **optional**
second parameter (0.1.5 passes it there; through 0.1.3 it is reached through `agentCtx.agent`, removed
at 0.1.5), the inbox's pending work is read from `nextStep`/`nextTurn` (the `hasPending` getter was
removed), and the RPC registration injects `webServer` alongside `connection` (0.1.5's connection
plugin registers its route on the context the service was provided from and that context must inject
it). Declaration metadata moved with them: `compatibility.json` gained the release and made it the
default, `profile/package.json`'s `dsh.bundle.requires.harness` lists all three, and the 24 peer ranges
accept it. Test-side adaptations: the provider-visible system prompt is read through one helper that
accepts either carrier (0.1.5's agent loop forbids `options.system` and carries the prompt in
`messages` as surface node 0), and the synthetic web host composes `Connection` inside a scope that
injects `webServer`.

The same pass fixed the reason the three real-host tiers could not run at all before it: the plugin
published its derived mission board into the owner session as a plugin-owned `swarm/mission` event,
which the host's closed session vocabulary refuses to read back (`SessionFormatUnsupportedError` on
every supported host). The publication and the host projection registration are deleted; the board is
the single derivation over `swarm.sqlite`, and `tests/r17-projection.test.mjs` pins that no `src/`
module appends a session event.

Both targets use isolated SDK links. The rc.1 copy runs the same emitted JavaScript against rc.1 dependencies and its actual CLI; it is not an alpha.2-linked plugin with only a different CLI environment variable. Host and client TypeScript are also checked against the selected SDK without re-emitting that copy.

### The RPC surface moved onto the host's shared channel (2026-09-12)

Booting the native-sidebar host exposed a second adaptation gap, this one on the
host side, and it is fixed in the same pass:

- **A plugin-owned channel is unusable from 0.1.5.** `ctx.connection.rpc.handle('/agent-swarm', …)`
  registers the route through the connection service, which reads `webServer` on a
  context that injects `credentials` alone. Cordis refuses that access
  (`cannot get property "webServer" without inject`), the route is never mounted,
  and every panel call dies with `HTTP 405`.
- **The shared channel admits exactly one interceptor.** `rpc.intercept('/api', …)`
  answers `connection: shared RPC channel "/api" already has an interceptor` on a
  composed host, so it is not available either.
- **What works on all three releases** is the host's documented mechanism for
  plugin endpoints: one exact Fetch route per endpoint on the shared `/api`
  channel, consulted before the interceptor and behind its Host, Origin and
  browser-authentication fence. The client already posts the standard envelope to
  `<channel>/<endpoint>`, so the change is one address on each side plus the
  endpoint list (`SWARM_WEB_ENDPOINTS`, pinned against the handler's dispatch and
  the naming manifest). The route's framing mirrors the host's channel handler:
  415 for a non-JSON media type, 400 for a body that is not JSON, and a
  `gateway/bad-request` envelope for a malformed or mismatched request.

Measured on the same isolated 0.1.5-rc.1 host: before the fix
`POST /agent-swarm/state → 405` and (after the address change but before the route
change) `POST /api/agent-swarm/state → 404`; now `POST /api/agent-swarm/state → 200`
with the plugin's own envelope, and the panel in the native sidebar reports
**Connected** with the start-guide body, no standalone dock and no page error
(`~/.dsh/agent-swarm-native015/verify/native-sidebar-5196-wired.png`). The real-HTTP
suites (`tests/web-api.test.mjs`, `tests/web-api-sanitize.test.mjs`, 23 cases)
drive a composed connection plugin, web server, browser authentication and the
routes end to end, and the full behavioral suite is re-run on the final code.

### The panel moved to the host's right sidebar (2026-09-12)

The owner asked for the panel beside the conversation rather than in the main
column. Harness 0.1.5 exposes the same mechanism the Files pane uses, and it is
public: a tab TYPE in the `sidebarRightTabs` registry (`id`, `kind`, the chip
title and the guide capsule), the panel BODY in the keyed `sidebar.right.pane.tab`
seat under that id, and navigation through the `sidebarRight` controller
(`openTab(kind, { revealIfOpened: true })`). The guide capsule matters: a page
type that recognizes no resource address is otherwise unreachable from the UI,
which the first attempt proved — the tab registered, and nothing could open it.

Measured on the isolated 0.1.5-rc.1 host (port 5196, headless Chromium): the right
sidebar's tab strip now reads **Agent Swarm** beside Files; the panel renders
inside the pane at `x=792, y=38, 648×862` on a 1440×900 viewport; the state RPC is
`200` and the panel reports **Connected**; the standalone dock is absent and no
page error is logged (`~/.dsh/agent-swarm-native015/verify/right-sidebar-5196-open.png`).
The left column's Global panels list is empty again — the plugin registers one
surface, not two.

## Native sidebar adaptation (2026-09-12) — current

Harness 0.1.5 introduced the host's own sidebar (`@deepseek-ai/dsh-client-ui-sidebar`).
Its extension point is the root-scoped `sidebar.panellist` list plus the layout's
root-scoped `main` keyed slot: an icon registration and a panel registration that
share one id, selected through `ctx.layout.selectPanel`. 0.1.3-alpha.2 and
0.1.2-rc.1 ship an earlier sidebar without `sidebar.panellist`, so the adapter is
structural (registered by slot name, no import of the sidebar package) and the
standalone dock remains their surface.

Measured on an isolated 0.1.5-rc.1 host booted for this check
(`/Users/tongtao/code/dsh-015-rc1`, port 5196, its own `DSH_HOME`, plugin snapshot
and `statePath` — the running 5192 preview was left untouched), with the real Web
application in headless Chromium:

| Check | Result |
| --- | --- |
| `npm run typecheck` (0.1.3-alpha.2 farm) | exit 0 — the adapter compiles against a host that has no `sidebar.panellist` |
| Client suites (`ui`, `ui-progress`, `client-findings`, `client-event-projection`, `r17-worker-names`, `sidebar`, `r17-projection`, `client-command`) | **79/79** |
| `npm run test:pack` (clean checkout of the committed artifact) | passed, 190 published files |
| Rail registration | exactly one button in the host's `nav[aria-label="Global panels"]`: **"Agent Swarm"** |
| Wake | clicking it mounts the panel in the main column: `[data-swarm-panel]` at x=280, 1160×900 beside the 280px sidebar |
| Surface preference | the standalone dock is **absent** (`[data-swarm-dock]` count 0) once the native panel is registered |
| Console | no page errors, no adapter warnings |

The isolated host has no conversation of its own, so the panel reports its
no-session state there ("Select a conversation to manage its missions"); the
session-scoped RPC path is the one already measured on the running preview.

## Second UI pass (2026-09-11, client only) — current

The owner asked for the remaining items of the 2026-09-11 UI review and then for the attended
preview restart. The pass changes `src/client/` only (feed grouping, lane counts and empty-lane
collapse, the clamped card reason, the sidebar's stated derivation, the `DisposalRegistry`, and the
dock's inline-style layout shift), so the runtime, store, adapter and admission paths are untouched
and the replay digest is unchanged. Measured on the committed artifact `1f62695`, with the SDK farm
repointed per row (the tracked linker still enforces `compatibility.json`).

| Check | Result |
| --- | --- |
| `npm run typecheck` | exit 0 on both farms (`0.1.3-alpha.2`, `0.1.5-rc.1`) |
| Emitted JavaScript (`lib/**/*.js`) | 59 files, SHA-256 `2a654ad5c839eb96db5b24b802bce9283d7e521f3fb43b5f3f581771c0505ee3` |
| Complete behavioral suite (`node --test tests/*.test.mjs`) | **849 tests: 847 passed, 2 failed** on this host; the two failing files pass alone (see the load note) |
| `npm run test:faults` | **24/24** on both farms |
| `npm run test:replay` | `REPLAY OK`, digest `sha256:61a921e64088b78b957cd6aeaa563d5436d4a6eae4b0130725d1f3c74c6f971e` (unchanged by this pass) |
| `npm run test:harness` (real Loader composition) | passed on `0.1.3-alpha.2` and `0.1.5-rc.1` |
| `npm run test:profile` (installed bundle through the real CLI) | passed on both |
| `npm run test:pack` (clean checkout of the committed artifact) | passed on both; 190 published files |
| `npm run test:bundle` | 7/7 on `0.1.3-alpha.2`, passed on `0.1.5-rc.1` |

The pass adds six tests (843 → 849): the actor-grouping derivation and its rendered order, the lane
counts and the collapsed empty lane, the reason clamp (full reason one disclosure away, short reason
inline), the owner-state disclosure (including the new `count` field and the Chinese strings), the
`DisposalRegistry` contract, and the dock geometry plus the two source guards that keep `#root` and
`!important` out of the stylesheet. The clean-checkout pack tier is also the gate that caught the new
`src/client/lifecycle.ts` while it was still untracked: the tier builds only tracked files, so the
module had to be committed before the packed artifact could compose.

Layout facts were measured in headless Chromium against the rendered board and panel, not inferred
from markup: the lane-count strip sits above the board (strip y 924, board y 959) with all seven chips
(`ready 1 · queued 1 · active 1 · review 1 · blocked 0 · cancelled 0 · done 1`); an empty lane is
**20 px** tall (header only, 1 px rule, no placeholder box) where a filled lane is 240 px; the
lane-title colour rules that no code had ever triggered now apply (`queued` `rgb(157,182,212)`,
`cancelled` `rgb(154,160,173)`); the Activity tab renders three actor groups (runtime, Nova, Atlas —
20 retained events each, member groups drawing 54 and 50 sprite rects and the runtime group none); the
clamped reason is one 17 px line whose full 294-character text is one disclosure away; the tab bar
reports `Work board 10 · Dependency graph 10 · Evidence 2 · Activity 5`; and the state-provenance
disclosure reports phase `waiting-for-owner` with the durable evidence
`task t4 status=submitted without a live review`.

**Load note (this host, not a product claim).** The host running the suite also runs the live preview
host and the owner's browser; load average was 12–33 during the measurements. Five wall-clock-bound
cases failed in a run that shared the machine with a browser and a second suite, and two different
wall-clock-bound cases failed in the serial run published above (`durability-w9-recovery`,
`lease-liveness`; the first took 175 s where it takes 7 s alone). Every failing file passes when run
by itself, and no assertion was changed to make that happen. This is recorded in
`docs/known-limitations.md` with the same evidence.

## Historical revision baseline (2026-09-09, superseded)

This table is retained as historical evidence: it describes revision `a226108`, not the round-4 head. The round-4 baseline below supersedes it.

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

## Round-4 baseline (T9 tree, 2026-09-09, superseded by the integrated measurement)

This is the round-4 measurement taken on the T9 artifact base — the accepted T4 scalability artifact `832b6335` plus the T9 documentation and packaging changes — not on the final integration. The integration task and the owner's gate must recompute the same three numbers on the integrated artifact with the commands below; if they differ, this table is superseded by the integrated measurement.

| Check | Result on the T9 tree |
| --- | --- |
| Host/client TypeScript and production browser build | Passed (`npm run build`) |
| Emitted JavaScript | 45 files, SHA-256 `ef872275e787196d4b80865e27e76577aa66414cb8a45d20edcaffc5757024dc` |
| Complete behavioral suite (`node --test tests/*.test.mjs`) | **357/357 passed**, 0 failed, 0 skipped |
| Clean pack manifest (`npm pack --dry-run --json --ignore-scripts` after a build) | `files=145`; `scripts/packed-smoke.mjs` included; `lib/index.js` and `lib/client.js` present |
| `npm run test:packed` | Passed (`packed-smoke: 10 export target(s) and 8 shipped file(s) present`) |
| `npm run test:load` | Passed: measured envelope at N=16/32 (maximum concurrent leases 8/16, queue high-water 16/32, admission p50/p95 sub-millisecond, exact limit hit `queue_full@taskClass(implementation)=8/16`, per-worker observation 829B → 832B) |
| `npm run test:faults` | Runs without a sandbox; provider tier B (F3a/F3b/F3c) needs a built Harness checkout (see below) |
| `npm run test:harness`, `test:pack`, `test:profile` | Host-only: they compose a real Harness profile and need a host that permits nested `sandbox_apply`; the owner runs them in the round gate |
| `npm run test:isolation` | Host-only: it drives the real sandbox provider and needs a built Harness checkout; the owner runs it in the round gate |
| `npm run test:web`, `test:command-web` | Not re-run here; they must run sequentially on an idle host (see below) |

Recompute the digest, the file count and the unit count after any source change lands:

```sh
npm run link:dsh && npm run build
# Emitted JavaScript: sorted lib-relative .js paths, a NUL separator and file contents.
node --input-type=module -e "import {createHash} from 'node:crypto';import {readdir,readFile} from 'node:fs/promises';import {join} from 'node:path';const lib=join(process.cwd(),'lib');const files=(await readdir(lib,{recursive:true})).filter(p=>p.endsWith('.js')).sort();const h=createHash('sha256');for(const p of files){h.update(p+'\0');h.update(await readFile(join(lib,p)))};console.log(files.length,h.digest('hex'))"
# Behavioral suite: the final `# tests` and `# pass` lines are the count.
node --test tests/*.test.mjs | tail -12
# Packed manifest: file count with lifecycle scripts disabled after a build.
npm pack --dry-run --json --ignore-scripts --cache "$(mktemp -d)" | node -e "const [m]=JSON.parse(require('node:fs').readFileSync(0,'utf8'));console.log('files='+m.files.length)"
```

## Round-4 baseline (integrated head, 2026-09-09)

This is the round-4 measurement recomputed on the integrated artifact
(`task_24f706c6`: the T4 chain + W18 + T7 + the client repair + the D1 defaults +
the materialized trace/ceiling/replay lineage), with the commands above. It
supersedes the T9-tree table for the final round-4 claim.

| Check | Result on the integrated head |
| --- | --- |
| Host/client TypeScript and production browser build | Passed (`npm run typecheck`, `npm run build`) |
| Emitted JavaScript | 46 files, SHA-256 `381f8844b17a85e68c0b796f87719d299b5853fb1eced8ec849352e39c4fec19` |
| Complete behavioral suite (`node --test tests/*.test.mjs`) | **409/409 passed**, 0 failed, 0 skipped |
| Clean pack manifest (`npm pack --dry-run --json --ignore-scripts` after a build) | `files=148` |
| `npm run test:packed` | Passed (`packed-smoke: 10 export target(s) and 8 shipped file(s) present`) |
| `npm run test:replay` | `REPLAY OK` — 13 spans, 6 commands compared, contract compliance 1.000, causal closure 1.000, 26/26 payloads verified, 0 provider calls |
| `npm run test:faults` | **20/20 fault scenarios passed** (F1–F17, each proving its injected fault fired) |
| `npm run test:load` | Passed: N=16/32, maximum concurrent leases 8/16, queue high-water 16/32, admission p50/p95 sub-millisecond, exact limit `queue_full@taskClass(implementation)=8/16`, per-worker observation 861B → 864B (BOUNDED) |
| `npm run test:harness`, `test:pack`, `test:profile` | Host-only: they compose a real Harness profile whose sandbox requests `workspace-write`; inside the worker sandbox macOS denies nested `sandbox_apply` (`SandboxUnavailableError`). The owner runs them in the gate |
| `npm run test:isolation` | Host-only: it drives the real sandbox provider through `confinedCheckArgv`; the owner runs it in the gate |
| `npm run test:web`, `test:command-web` | Not run here; they are load-sensitive browser smokes and must run sequentially on an idle host |

The `test:pack` clean checkout materializes only `git ls-files`, so it cannot see
files that the host capture has not committed yet. The integration verified the
equivalent condition directly: a clean directory containing exactly the tracked
tree plus the new untracked sources builds and packs with lifecycle scripts
enabled (208 files, `npm run build` exit 0, `npm pack` produced the tarball). The
owner gate re-runs `test:pack` on the committed artifact.

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
npm run test:faults
npm run test:replay
npm run test:load
npm run test:harness
npm run test:pack
npm run test:packed
npm run test:profile
npm run test:web
npm run test:command-web
npm run test:validation-repair-web
```

Browser checks need the matching Harness Web build and Playwright browser environment. Set `DSH_WEB_SMOKE_ARTIFACTS` to retain separate evidence directories for different host versions. Test profiles and repositories are isolated. Running the large Harness suites and multiple browsers concurrently can increase load enough to exceed small fixture timeouts; run them sequentially when reproducing. Optional `test:deepseek` and `test:command-deepseek` scripts use real provider credentials and are separate, billable checks.

The behavioral tests import the built `lib/` output. `npm test` builds first; a bare `node --test tests/*.test.mjs` needs `npm run link:dsh` and `npm run build` first, otherwise it stops at `ERR_MODULE_NOT_FOUND .../lib/runtime.js`. A clean checkout without linked dependencies stops earlier at `tsc: command not found`.

`npm run test:harness`, `npm run test:pack` and `npm run test:profile` compose a real Harness profile whose sandbox requests `workspace-write`, so they require a host that permits nested `sandbox_apply`. Inside an outer workspace-write sandbox, macOS denies it (`sandbox-exec: sandbox_apply: Operation not permitted`) and the composition fails with `SandboxUnavailableError`. `test:pack` and `test:profile` detect an unusable nested sandbox before the composition and abort with that prerequisite; set `DSH_SWARM_SKIP_SANDBOX_PREFLIGHT=1` to attempt the composition anyway. `npm run test:harness` runs the composition directly and reports the same `SandboxUnavailableError`.

`npm run test:faults` needs no sandbox, but its provider-fault tier B (F3a/F3b/F3c) boots the real Harness Loader, so it needs a built supported Harness checkout: `DSH_HARNESS_ROOT` or `DSH_SOURCE`, or `~/.dsh/source/current` (or a sibling `deepseek-harness-rc1`/`deepseek-harness-latest`) with built `lib/` entries matching [compatibility.json](../compatibility.json). Without one it fails with `The fault suite needs a built Harness checkout; set DSH_HARNESS_ROOT`. The host-only `npm run test:isolation` drives the real sandbox provider and needs the same built checkout plus a host that permits the platform sandbox; it is not part of the worker check set. The published tarball ships only the built entry points, the manifest, `cordis.patch.yml`, four documents and `scripts/packed-smoke.mjs`, so the full suite requires the repository checkout (see [known-limitations.md](known-limitations.md)).

`npm run test:web` and `npm run test:command-web` launch the real Web application and are load-sensitive. Run them sequentially on an idle host, without other large suites or browsers in parallel, and re-run a timeout before treating it as a product defect.

Raw local logs, traces, screenshots, credentials and preview state are excluded from the public repository. Remaining operational boundaries are in [known-limitations.md](known-limitations.md).
