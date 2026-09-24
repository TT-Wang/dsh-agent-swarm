# Installation and operations

[English](operations.md) · [简体中文](operations.zh-CN.md) · [Product overview](../README.md)

This guide covers installing Agent Swarm, choosing its storage, running missions and recovering interrupted work. Configuration is for the person operating Harness; the primary agent chooses the team and task budgets for ordinary `/agent-swarm` requests.

## Supported environment

The repository records these exact supported Harness releases in [compatibility.json](../compatibility.json):

| Harness release | Release commit |
| --- | --- |
| [0.1.5-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1) | `183f08e9c6dde7e36cd2318eaee70b0da08fb35e` |
| [0.1.6-alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.2) | `ddefc45fbc7f8e46dd73185e68295696d1297887` |
| [0.1.3-alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.2) | `82a5fd61a7cf5c293cec4bdff68f455398d685e9` |
| [0.1.2-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1) | `a66e4702047846cdaa10c66c9d3df3951f5ea70d` |

All three are prereleases. The development linker checks the recorded release revision, not only the package version. Compatibility with `0.1.0-rc.5`, unreleased commits or arbitrary custom profiles is not claimed. Better Sidebar integration was exercised against 0.18.0.

You need:

- Node.js `^22.19.0 || >=24.0.0`, Git, and macOS or Linux. Checks and syntax probes use `/bin/sh`; delivery requires POSIX link semantics. Windows execution is unsupported.
- A checkout of a supported Harness release, with its dependencies installed and its CLI and Web application built.
- A working model/provider configuration in Harness. **Harness manages API keys and credentials**; the plugin uses the primary conversation's model by default. Configure credentials in the host rather than copying a key into this plugin.
- A local Git project. Distributed workers and non-Git workspaces are not implemented.

## Build and install

```sh
git clone https://github.com/TT-Wang/dsh-agent-swarm.git
cd dsh-agent-swarm

export DSH_HARNESS_ROOT="/absolute/path/to/deepseek-harness"
npm run link:dsh
npm run build
```

`link:dsh` links the shared runtime packages and build tools from that Harness checkout. A separate `npm install` in the plugin directory is not needed.

Choose **one** of the following mounts, using the matching Harness CLI and running the command from the plugin checkout root.

### Direct plugin mount

```sh
node "$DSH_HARNESS_ROOT/apps/cli/lib/bin.js" plugin --profile web add "link:$PWD"
```

The plugin package itself becomes a profile bundle layer. Keep the linked directory in place.

### Declarative bundle mount

```sh
node "$DSH_HARNESS_ROOT/apps/cli/lib/bin.js" plugin --profile web add "file:$PWD/profile"
```

The [bundle profile](../profile/README.md) installs the plugin and its Web client together, after the required `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` layers. It declares portable storage roots: `$DSH_AGENT_SWARM_ROOT`, otherwise `$DSH_HOME/agent-swarm`. Override that variable or use a `--patch` overlay targeting the `dsh-external-agent-swarm` row.

**Do not mount both alternatives.** Both insert the same Loader row, and the bundle declares that conflict in its metadata.

### Start and update

```sh
cd /absolute/path/to/your-project
node "$DSH_HARNESS_ROOT/apps/cli/lib/bin.js" --profile web
```

Open the authenticated launch URL printed by Harness. Its login exchange sets the browser cookie; a bare unauthenticated URL returns HTTP 401. The plugin adds mission and session ownership checks to host authentication.

For a direct `link:` mount, rebuild the plugin, restart the profile and refresh the browser. A declarative `file:` mount packages the payload: after rebuilding, rerun its `plugin --profile web add "file:$PWD/profile"` command from the plugin checkout root (or run `dsh plugin --profile web install` with the matching CLI), then restart the profile and refresh the browser.

If several Harness versions run on the same machine, use a separate linked checkout or built copy for each. Relinking one shared plugin directory changes the dependencies every host loads.

## Run a mission

Choose a model in a conversation rooted in your Git project, then enter:

```text
/agent-swarm Add search to this project, preserve the existing API, and verify the relevant tests pass.
```

The primary agent chooses members, task structure, verification commands and resource limits. You do not need to enter worker counts or token budgets. An advanced manual planner remains available; saving a draft starts no workers.

Before planning, the plugin captures tracked edits and non-ignored new files in a private Git snapshot. Your source branch, index and working files stay unchanged. The planning checkout and workers share that frozen baseline, including after a restart. Unresolved merge conflicts, dirty submodules and unsupported layouts produce an actionable error instead of silently omitting files.

New automatic plans treat task assignees as preferences. If a preferred member is busy or unavailable, eligible idle members can take work that has never started; an active or recovering task keeps its existing lifecycle. The primary can set `assignmentMode: pinned` when a task requires a specific member or model. Pinned work keeps its required route through automatic startup recovery; the primary agent can explicitly amend its assignee after reviewing the requirement. Manual drafts and old task rows keep their previous binding when the field is absent. Choosing an assignee in the manual editor pins it; clearing the assignee clears its mode. No extra user configuration or planning turn is required, and step/token budgets remain the primary agent's decision.

### Open the sidebar

The plugin uses the first available surface:

1. **Native Harness right sidebar**, on the supported 0.1.5 release: open **New tab → Start → Agent Swarm** beside Files. The command and conversation card reveal the same tab.
2. **Better Sidebar**, on older supported hosts when installed: choose **Agent Swarm** in the **+** tab menu.
3. **Standalone dock** beside the conversation, with remembered width; narrow screens place it below the conversation.

Only one surface mounts at a time. Hiding it stops display updates, not workers. Worker activity shows host-observed operations and signal freshness; it does not stream model tokens or guarantee useful progress. On disconnection, retained activity is marked as last-observed and its timer freezes. Missing fresh activity stops busy animations without declaring a worker failed.

### Controls and delivery

- **Pause / Resume:** pause work and resume from durable state. Raising a limit does not resume a paused mission or reset usage. The execution-duration allowance excludes pauses and idle/resource waits. An explicit `deadlineAt` remains a fixed wall-clock deadline; neither consumption nor that deadline resets on resume.
- **Stop:** requires a second click in the sidebar. Stopped missions stop owner notifications; paused missions retain unanswered questions while other reports wait. Automatically completed missions preserve queued facts.
- **Complete:** normally automatic when required independent acceptances cover the mission criteria; a manual control is also available.
- **View changes / Apply result:** for a completed code mission, inspect the independently accepted commit and apply its changes relative to the original project snapshot. Application preserves your branch and index, reports conflicts before writing and does not stage, commit or push. If application times out, check the host receipt before explicitly retrying.

## Storage and configuration

Settings belong to Loader row `dsh-external-agent-swarm`. The full schema is in [src/index.ts](../src/index.ts).

| Setting | Default | Purpose |
| --- | --- | --- |
| `statePath` | `~/.dsh/agent-swarm/swarm.sqlite` | Durable coordination state; one live runtime per file. |
| `workspacesRoot` | `~/.dsh/agent-swarm/workspaces` | Snapshots, member worktrees and verification checkouts. Must be outside the source repository. |
| `verificationDependencyDirs` | `["node_modules", ".venv", "venv", "vendor", ".tox"]` | Installed dependency directories made available to clean verification checkouts. |
| `verificationDependencyMode` | `"link"` | Effective mode is `copy` unless the explicit link-read opt-in below is enabled. |
| `allowDependencyLinkReads` | `false` | Allows configured `link` mode, including read-through access to the source toolchain. |
| `checkConcurrency` | `2` | Maximum simultaneous declared checks per host; the remainder queue in FIFO order. |
| `cacheReadWeight` | `0.1` | Weight charged to the token budget for cache reads; raw usage remains separate. |
| `budgetWarnAt` | `[0.7, 0.9]` | Fractions at which the primary agent is warned for each resource dimension. |
| `authorizedWorkspaces` | `[]` | Human-configured roots outside the session cwd: `{ path, note?, expiresAt? }`. |
| `planningTimeoutMs` | `600000` | Prelaunch planning watchdog; the primary agent can extend it with a reason. |
| `workerStartTimeoutMs` | `60000` | Native worker startup bound; recovery starts members independently and cancels abandoned startups. This is a host lifecycle limit, not a model step/token budget. |
| `checkTimeoutMs` | `600000` | Fallback per-check timeout when the task supplies none. |
| `leaseMs` | `120000` | Attempt lease, renewed while a real operation is observed. |
| `tickMs` | `1000` | Scheduler tick interval (minimum 10), and the unit of the tick-derived windows: the unreviewed-submission grace (30 ticks, at most 1 s), the no-progress window (`stallPasses` ticks), and the preparation back-off bound and failed-start retry (one tick each). |

**Changing `DSH_HOME` alone does not isolate the plugin's default storage.** For independent Harness processes, give each its own absolute `statePath` and `workspacesRoot` through a profile overlay, or use the bundle's explicit roots. A database owner lock rejects a second live runtime and identifies the holding process. A lock left by a dead process can be reclaimed; do not delete coordination state to resolve a live ownership conflict.

These infrastructure settings do not replace the primary agent's task-specific budgets and policies. Retained worktrees and Git refs require explicit cleanup.

### Authorize another workspace

A mission may use the calling session's working directory or a realpath inside a root in `authorizedWorkspaces`. A human edits the profile or `cordis.patch.yml` and restarts Harness to change these roots. No model-callable tool can add, widen or revoke them.

The resolved workspace and matched grant are recorded durably. An unauthorized path returns `[workspace_not_authorized]` with the required correction. Removing a root and restarting prevents new missions there and fences an existing mission at its next workspace preparation or verification checkout, with a blocked reason and an owner notice.

Authorization is not confidentiality. It does not add independent network or credential isolation; write access to configuration files and replacement of a root remain relevant risks. See [known limitations](known-limitations.md).

## Resource accounting

The primary agent chooses worker and mission ceilings and can revise them with a recorded reason. Usage persists across resume. Planning requests explicit task step and finding ceilings; if a fallback is used, `ceilingProvenance` records that fact through revalidation and restart.

- **Usage buckets:** uncached input, cache read, cache write, output and physical request count are recorded per worker and mission. Reasoning usage is a share of output, not an extra bucket to add again.
- **Budget weighting:** cache reads count at `cacheReadWeight` (default `0.1`). Raw token volume and budget-charged volume therefore differ; this is a weighting policy, not an exact provider invoice.
- **Primary conversation:** its usage is attributed separately and is not charged to the worker pool.
- **Warnings and admission:** the primary agent receives threshold notices; admission accounts for estimated in-flight usage before allowing another step. An unusually large request can still cross a ceiling, and usage a provider does not report cannot be counted.
- **Checks:** the host records queue and run times under `checkConcurrency`. Verification uses the task timeout, or the configured fallback.

## Recovery and troubleshooting

| Situation | What to expect and do |
| --- | --- |
| Planning times out before a mission exists | The saved request, frozen snapshot and usage remain. Use sidebar **Retry** or **Stop**; the agent/API can control the saved `requestId`. Retry advances the planning epoch so an old callback cannot launch cancelled work. |
| Mission paused or budget exhausted | Ask the primary agent to inspect the reason, adjust the plan or ceiling as needed, then resume. Resuming resets neither consumption nor an explicit fixed deadline. |
| Worker or host interrupted | Durable state and captured artifacts remain. Host-caused stops re-pend tasks without spending recovery credit; attempt leases fence stale workers. Recovery limits still apply to repeated execution failures. |
| Provider quota, rate limit or availability failure | Classified outages preserve the attempt without spending recovery credit and never retire a member. A member whose start fails inside its recorded outage window (5 minutes) is probed once per window instead of every tick, and work leaving it prefers a live member outside an outage window. The primary agent is notified once per outage (on each class transition). |
| A worker cannot start | Each failed start re-pends the task without spending recovery credit. After 3 consecutive failures the member is retired and its work moves to another capable live member. When no live member can start a task any more, the primary agent receives one notice naming the task, each retired member with its consecutive start failures and last error, and the exits: admit a working member with `swarm_add_member` (it claims unpinned work), move pinned work with `swarm_control` (`action: "amend"`, `changes.assigneeId`), or withdraw it with `swarm_cancel`. The task stays pending and nothing retries it. |
| Rejected task leaves downstream work waiting | The primary agent can admit a replacement that retains the original acceptance criteria. Dependents resolve through the replacement after it is accepted. |
| Owner is offline or a native call is hung | Notices remain durable. The owner must become available and reach a native inbox boundary before acting; runtime cancellation is independent. Delivery is not a guarantee of an immediate model response. |
| Store is truncated or missing | The store fails closed and names its snapshot. The primary agent can stage one validated snapshot with `swarm_restore`; the next host start applies it before opening the store. |
| Check cannot find a command | Inspect the installed toolchain and `verificationDependencyDirs`. A missing command is an environment failure. The plugin does not install project dependencies for you. |
| Browser returns HTTP 401 | Use the authenticated launch URL from the running Harness profile. |
| Missing provider key | Configure the model route and credentials in Harness. The plugin has no separate API-key store. |

Verification runs the declared commands against the exact submitted commit. A failed command cannot be waived by an agent's success claim, but passing checks do not prove the commands cover every requirement. Ignored dependency directories are copied into verification checkouts by default; they are installed toolchain state, not a fresh CI install. Explicit link mode can expose reads through to the source checkout.

Copy mode supports a dependency directory that is itself a symlink and relocates links within that dependency. A link to an external regular executable, such as a virtualenv's Python interpreter, becomes a copied executable; system libraries may still be required. Broken links, links into other source checkout content, and links to external directories or non-executable data cannot be materialised: no declared command runs, the verification is recorded as an infrastructure failure (`(verification preparation)`, exit 125) and the review is deferred with the repair in its output (`verificationDependencyMode: "link"` with `allowDependencyLinkReads: true`, or `verificationDependencyDirs`); resume it with `swarm_control` once the host is configured. Use self-contained dependencies, or explicitly opt into external reads with both `verificationDependencyMode: link` and `allowDependencyLinkReads: true` in the host configuration.

Snapshot selection follows the current Git index: a file removed from the index and now ignored remains excluded even if HEAD previously tracked it. Capture checks the resulting private index against current file contents and retries detected changes; concurrent multi-file edits still cannot be treated as an atomic filesystem snapshot.

An invalid live update retains the last valid view and retries a full snapshot with backoff. Continued invalid data stays visibly disconnected rather than displaying invented progress. Owners can settle existing questions after pause, stop or completion without resuming workers. Trace metrics describe a bounded span window and expose its truncation explicitly; full durable records remain available separately.

Worker confinement follows the configured Harness sandbox. Shared temporary directories remain a possible cross-member channel. Delivery Git subprocesses and synchronous admission ignore probes also retain the process-management exceptions described in [known limitations](known-limitations.md).

## Companion context policy

[dsh-slice-agent-loop](https://github.com/TT-Wang/dsh-slice-agent-loop) (`@dsh-external/dsh-slice-agent-loop`) is an optional companion for managing each session's retained context. Agent Swarm coordinates missions across workers; the slice policy manages history within each native session and provides `recall_turn`, `recall_search`, `recall_step` and `expand_result` to retrieve prior material. Context management does not change swarm acceptance, workspace or budget rules, and does not guarantee a particular cache hit rate or provider bill.

Mount the swarm and slice layers in the same profile using each project's installation instructions. Their tool names do not overlap. The slice package includes tool-result folding; do not add the standalone folding plugin beside it. Swarm storage still needs the explicit roots described above.

## Development and verification

After linking a supported Harness checkout:

```sh
npm run verify
```

This runs typecheck, build, the behavioral suite, packaged-artifact loading, real Loader composition, CLI profile installation, the declarative bundle checks and both browser workflows.

| Command | Coverage |
| --- | --- |
| `npm test` | Build and the full behavioral suite. |
| `npm run test:faults` | Fault injection; each scenario must establish that its fault fired. |
| `npm run test:replay` | Deterministic replay over the durable log. |
| `npm run test:load` | Admission and scheduling under load. |
| `npm run test:isolation` | Host-only sandbox and workspace confinement. |
| `npm run test:harness` | Real Harness Loader composition. |
| `npm run test:pack` / `npm run test:packed` | Packaged-artifact loading and declared behavior. |
| `npm run test:profile` | Real CLI profile installation and lifecycle. |
| `npm run test:bundle` | Bundle metadata, portable roots, host composition and real profile boot. |
| `npm run test:web` / `npm run test:command-web` | Sidebar and `/agent-swarm` browser workflows. |

These suites use temporary profiles and Git workspaces with scripted provider responses. They establish integration behavior, not model planning success rates. `npm run test:deepseek` and `npm run test:command-deepseek` make real provider requests, can incur charges and are excluded from `verify`. Completed runs and their limits are recorded in [validation](validation.md).

## Revise estimates and recover the same work

The primary agent receives durable advance warnings for mission resources and task steps/findings, including estimates for in-flight model requests. Warnings do not change task shape. `swarm_budget(missionId, taskId, taskBudget, reason)` updates finite task allocations; omit `taskId` and supply `budget` to update the mission. Used steps/tokens, task identity and artifacts stay intact. A resource-only wait continues after the extension and stop confirmation; an explicit user pause still needs resume. Findings are advisory; an explicit user stop remains in force.

`swarm_control(missionId, taskId, action: "amend", changes, reason)` corrects unsubmitted scope, dependencies, checks or assignee. `action: "resume"` retries the same task after a preparation or check-environment repair. Review retries keep the exact submitted artifact; failed assertions still need a corrected implementation and independent review. A worker stop and workspace preservation must finish before reassignment. A reassigned review recovers saved drafts only for the same immutable source; its new reviewer must independently inspect the pinned source and cite fresh tool evidence. Host checks still use a fresh exact-artifact checkout.

Integration workers can resolve listed files in `.swarm-integration-conflicts.json` using ordinary edits, then remove that manifest and submit. The host retains accepted dependency commits and checks the final scoped artifact. Unknown script names or inferred prose paths are planning hints; actual authorization, scoped writes, check execution and independent review remain enforced. Failed saved plans can be edited and relaunched without discarding their request, snapshot, admitted work or recorded consumption.

A mission cannot complete while required synthesis or review work remains unfinished, even if other accepted tasks repeat its acceptance text. A stranded task stays recoverable and notifies the primary; amend its dependencies or assignee in place. Withdraw obsolete work explicitly with `swarm_cancel`. Completion itself never cancels tasks.

Check-environment records distinguish the configured `dependencyLinks.dirs` set from the actual relative `materializedPaths` found for that execution. Directory ordering and absent optional dependency folders do not change the configured policy; real policy-set or copy/link-mode changes still reject a mismatched verification.

## Recovering orchestration issues

Amend a stale dependency list on the existing task before creating a duplicate deliverable. `changes.dependencies` replaces the entire list; the response includes added and removed dependencies. Cancelling a prerequisite reports `strandedDependents`. Replacements must continue the live repair chain, rather than fork an ancestor with an active or accepted descendant.

A stop must finish and preserve the previous attempt before its member workspace can be reused. A timed-out queue wait returns an actionable refusal without running overlapping workspace operations. The owner can still pause, stop, inspect and work on other missions. Deterministic preservation failures retain the fence and emit one decision notice per task/epoch/cause; after repairing the reported condition, `swarm_control(action: "resume", taskId, reason)` retries cleanup even for a cancelled task without reviving it.

Named in-scope ignored output files are included in private recovery checkpoints. Unlisted ignored files are not collected: a conflicting workspace switch refuses and reports the paths. `swarm_verify.deliverables` optionally captures a separate review report in immutable blobs; the verdict remains durable when no report file is requested. The source artifact and its host checks remain pinned to the original commit.

Budget warnings include task slots needed for known unpaired reviews. `suggestedLimit` restores warning headroom only; the primary must consider remaining work and actual progress before choosing a new ceiling. A delivery marked queued is not proof of worker receipt: failed transports appear in the compact member view and wake the primary. Owner reminders are checked again when the host admits them into context, so stopped work, answered questions and superseded budget warnings do not cause an extra decision turn. Already consumed historical messages remain in the session log.
