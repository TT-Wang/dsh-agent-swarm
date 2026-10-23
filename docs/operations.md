# Installation and operations

[English](operations.md) · [简体中文](operations.zh-CN.md) · [Product overview](../README.md)

This guide covers installing Agent Swarm, choosing its storage, running missions and recovering interrupted work. Configuration is for the person operating Harness; the primary agent chooses the team and task budgets for ordinary `/agent-swarm` requests.

## Supported environment

The repository records the one supported Harness release in [compatibility.json](../compatibility.json):

| Harness release | Release commit |
| --- | --- |
| [0.2.1-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2) (npm `latest` and `next`) | `687f282e8625c6b8d11ff58211a90524be2e4317` |

It is a prerelease. The development linker checks the recorded release revision, not only the package version. Compatibility with other releases, unreleased commits or arbitrary custom profiles is not claimed. `0.1.5-rc.3` and `0.1.7-rc.1` were dropped on 2026-10-22, and `a28b116` is the last plugin revision that runs on them; a Harness home used with them moves to 0.2.1-rc.2 once, as [Move a 0.1.x Harness home to 0.2.1-rc.2](#move-a-01x-harness-home-to-021-rc2) describes. Better Sidebar integration was last exercised with Better Sidebar 0.18.0 on an earlier Harness release, not on 0.2.1-rc.2.

You need:

- Node.js `^22.19.0 || >=24.0.0`, Git, and macOS or Linux. Checks and syntax probes use `/bin/sh`; delivery requires POSIX link semantics. Windows execution is unsupported.
- A checkout of Harness 0.2.1-rc.2 at that commit, with its dependencies installed and its CLI and Web application built.
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

`link:dsh` links every Harness package from that checkout into `node_modules`, so the mounted plugin runs on the host's own modules, and links the build tools the plugin declares from it. On its own it needs no `npm install`. It also works over `npm ci` (see [Development and verification](#development-and-verification)): it then replaces each Harness package npm installed with the checkout's, after checking that both are the same version, and keeps the tools the lockfile installed. `npm ci` removes the links, so run `link:dsh` again after it.

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

The [bundle profile](../profile/README.md) installs the plugin and its Web client together, after the required `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` layers. Like the direct mount, it inserts the plugin row with an empty config, so both mounts open the same store: the plugin chooses its roots at start by the [storage root rule](#storage-roots). To choose other roots, set `DSH_AGENT_SWARM_ROOT` or use a `--patch` overlay targeting the `dsh-external-agent-swarm` row.

**Do not mount both alternatives.** Both insert the same Loader row, and the bundle declares that conflict in its metadata.

### Start and update

```sh
cd /absolute/path/to/your-project
node "$DSH_HARNESS_ROOT/apps/cli/lib/bin.js" --profile web
```

Open the authenticated launch URL printed by Harness. Its login exchange sets the browser cookie; a bare unauthenticated URL returns HTTP 401. The plugin adds mission and session ownership checks to host authentication.

For a direct `link:` mount, rebuild the plugin, restart the profile and refresh the browser. A declarative `file:` mount packages the payload: after rebuilding, rerun its `plugin --profile web add "file:$PWD/profile"` command from the plugin checkout root (or run `dsh plugin --profile web install` with the matching CLI), then restart the profile and refresh the browser.

If several Harness checkouts run on the same machine, use a separate linked plugin checkout or built copy for each. Relinking one shared plugin directory changes the dependencies every host using it loads.

## Move a 0.1.x Harness home to 0.2.1-rc.2

The plugin runs only on 0.2.1-rc.2. A Harness home (`DSH_HOME`) and plugin state that ran on 0.1.5-rc.3 or 0.1.7-rc.1 move to it once, without a migration step: 0.2.1-rc.2 reads the existing session logs, and the host change does not touch the plugin's store (`swarm.sqlite`, schema 8). The way back is closed, so before the first start on 0.2.1-rc.2:

1. **Stop the host and back up the home.** Copy `$DSH_HOME/sessions` together with the plugin's state where the plugin that ran on 0.1.x kept it: `statePath` with its `-wal` and `-shm` files, and `workspacesRoot`. That plugin, a revision up to `a28b116`, kept a root its composed row did not configure in `~/.dsh/agent-swarm` whatever `DSH_HOME` was: always on the direct mount, and on the bundle mount when a later layer replaced the row's config without both roots. A bundle row that kept its roots used `$DSH_AGENT_SWARM_ROOT`, else `$DSH_HOME/agent-swarm` (`~/.dsh/agent-swarm` without `DSH_HOME`). The current plugin may choose another root for the same install; see [storage roots](#storage-roots). Going back to 0.1.x means restoring that backup, which discards everything done on 0.2.1-rc.2, and running a plugin revision up to `a28b116`: 0.1.7-rc.1 refuses to install the current plugin and skips a mounted one, and 0.1.5-rc.3 has no such gate: the current plugin logs that the host is unsupported and is not expected to work there.
2. **Review the shared agent instructions.** 0.2.1-rc.2 also loads `AGENTS.md` from the shared agents directory (`$DSH_AGENTS_HOME`, by default `~/.agents`), beside `$DSH_HOME/AGENTS.md`. Workers mount their owner's agent preset, so under the Standard, Creator and PTC presets that file reaches every owner and worker prompt. The Minimal preset loads no instruction files.
3. **Do not move a home with live missions back to 0.1.x.**

The move is one-way for session logs:

- Every foreground `bash` call in the Standard, Creator and PTC presets writes `job/registered` and `job/settled` into the calling session, and a `working_directory` cd writes `working-directory/change` (so does a worker activation that returns a worker session to its member worktree). 0.1.5-rc.3 and 0.1.7-rc.1 refuse a log containing these events with `SessionFormatUnsupportedError` ("unknown to this harness and not marked ignorable"), so an owner or worker session that ran one bash command on 0.2.1-rc.2 can no longer be opened there.
- 0.2.1-rc.2 records each change in a session's tool set between two requests as a `developer/message`: an owner's promotion, or a session from 0.1.x resumed with the host tools 0.2.1-rc.2 adds. 0.1.7-rc.1 opens such a log, but its DeepSeek provider refuses a developer message in the request history (`UNSUPPORTED_CONTENT`), so every later request of that session fails.
- 0.1.5-rc.3 reads only session format 3 and refuses every log that 0.1.7-rc.1 or 0.2.1-rc.2 created or wrote, which is format 4.

If a home goes back anyway, the plugin does not detect it. Each refused worker session is an ordinary start failure ([A worker cannot start](#recovery-and-troubleshooting)): it spends no recovery credit, three consecutive failures retire the member and move its work to another capable live member, and every member that ran on 0.2.1-rc.2 fails the same way, so the owner is finally told which work no live member can start; `swarm_add_member` admits a member with a new session. A worker session that opens but cannot make a request is reported as that member's failure. An owner conversation a 0.1.x host refuses cannot be reopened, and its notices wait in the outbox. Restore the backup or return to 0.2.1-rc.2.

A preview root created on 0.1.x does not move with its home. `scripts/update-preview.mjs` keeps a snapshot's linked `node_modules` and refuses to boot the snapshot on any release but the one whose Harness SDK it links, so a preview runs the current plugin only as a new root from `scripts/start-preview.mjs` on 0.2.1-rc.2.

[Known limitations](known-limitations.md#supported-harness-versions) records the move back in detail.

## Run a mission

Choose a model in a conversation rooted in your Git project, then enter:

```text
/agent-swarm Add search to this project, preserve the existing API, and verify the relevant tests pass.
```

The primary agent chooses members, task structure, verification commands and resource limits. You do not need to enter worker counts or token budgets. An advanced manual planner remains available; saving a draft starts no workers.

Before planning, the plugin captures tracked edits and non-ignored new files in a private Git snapshot. Your source branch, index and working files stay unchanged. The planning checkout and workers share that frozen baseline, including after a restart. Unresolved merge conflicts, dirty submodules and unsupported layouts produce an actionable error instead of silently omitting files.

New automatic plans treat task assignees as preferences. If a preferred member is busy or unavailable, eligible idle members can take work that has never started; an active or recovering task keeps its existing lifecycle. The primary can set `assignmentMode: pinned` when a task requires a specific member or model. Pinned work keeps its required route through automatic startup recovery; the primary agent can explicitly amend its assignee after reviewing the requirement. Manual drafts and old task rows keep their previous binding when the field is absent. Choosing an assignee in the manual editor pins it; clearing the assignee clears its mode. No extra user configuration or planning turn is required, and step/token budgets remain the primary agent's decision.

Each member runs the model the primary conversation has selected, under the member's own `provider`, `model` and `reasoningEffort` where the plan sets them. Before a launch or `swarm_add_member` creates anything, the plugin prepares each member's route through Harness as the member's model step would. A route that does not resolve, a model this Harness release does not run, or a reasoning effort the model does not take refuses the plan; the refusal names each refused member, with the efforts its route accepts when the effort is refused, and the primary agent repairs the plan and relaunches. Nothing is downgraded. A route that changes after admission retires its member at the member's next model step ([Recovery and troubleshooting](#recovery-and-troubleshooting)).

### Open the sidebar

The plugin uses the first available surface:

1. **Native Harness right sidebar**: the **Agent Swarm** button at the bottom of the left navigation opens it; the command and conversation card reveal the same tab. The right sidebar belongs to one conversation, so a worker's conversation opens its own read-only view from the same button.
2. **Better Sidebar**, when a profile installs it: choose **Agent Swarm** in the **+** tab menu.

Hiding a surface stops its display updates, not workers. Worker activity shows host-observed operations and signal freshness; it does not stream model tokens or guarantee useful progress. On disconnection, retained activity is marked as last-observed and its timer freezes. Missing fresh activity stops busy animations without declaring a worker failed.

### Controls and delivery

- **Pause / Resume:** pause work and resume from durable state. Raising a limit does not resume a paused mission or reset usage. The execution-duration allowance excludes pauses and idle/resource waits. An explicit `deadlineAt` remains a fixed wall-clock deadline; neither consumption nor that deadline resets on resume.
- **Stop:** requires a second click in the sidebar. Stopped missions stop owner notifications; paused missions retain unanswered questions while other reports wait. Automatically completed missions preserve queued facts.
- **Complete:** normally automatic when required independent acceptances cover the mission criteria; a manual control is also available.
- **View changes / Apply result:** for a completed code mission, inspect the independently accepted commit and apply its changes relative to the original project snapshot. Application preserves your branch and index, reports conflicts before writing and does not stage, commit or push. If application times out, check the host receipt before explicitly retrying. One application runs per checkout at a time, under `<git dir>/dsh-agent-swarm-delivery/apply.lock`. A lock left by a process that exited, or whose PID now belongs to a later process, is reclaimed by the next application. Otherwise the refusal names the lock and the holding process; remove the lock only once that process is known not to be applying a result.

## Storage and configuration

Settings belong to Loader row `dsh-external-agent-swarm`. The full schema is in [src/index.ts](../src/index.ts).

| Setting | Default | Purpose |
| --- | --- | --- |
| `statePath` | `<root>/swarm.sqlite`, by the [root rule](#storage-roots) | Durable coordination state; one live runtime per file. |
| `workspacesRoot` | `<root>/workspaces`, by the [root rule](#storage-roots) | Snapshots, member worktrees and verification checkouts. Must be outside the source repository. |
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
| `tickMs` | `1000` | Scheduler tick interval (minimum 10), and the unit of the tick-derived windows: the review grace of an unreviewed submission (one tick, at least 1 s), and the preparation back-off bound and failed-start retry (one tick each). |

These infrastructure settings do not replace the primary agent's task-specific budgets and policies. Retained worktrees and Git refs require explicit cleanup.

### Storage roots

Both mounts insert the plugin row with an empty config, and the plugin chooses each of `statePath` and `workspacesRoot` at start, from the first of these that names it (`src/state-roots.ts`):

1. the row's own `statePath` or `workspacesRoot`, which must be absolute;
2. `$DSH_AGENT_SWARM_ROOT`, as `<root>/swarm.sqlite` and `<root>/workspaces`;
3. the Harness home's `agent-swarm` directory: `$DSH_HOME`, else `~/.dsh`.

The home is resolved the way the host resolves it: a blank `DSH_HOME` is unset, a leading `~` is expanded, and a relative path is resolved against the directory the host started in. `DSH_AGENT_SWARM_ROOT` is read by the same rule. Like every `DSH_*` name it comes only from the environment that launches the host: Harness refuses it in a `.env` file, and Desktop keeps the value it was launched with, not the login shell's. Hosts with separate homes therefore keep separate stores with no further configuration. The workspaces root must be canonical, so give a home under a symbolic link by its real path (on macOS `/tmp` and `/var` are links): otherwise the first mission is refused with `workspacesRoot must be canonical, without symlinks`. A database owner lock rejects a second live runtime on one store and identifies the holding process. A lock left by a dead process can be reclaimed; do not delete coordination state to resolve a live ownership conflict.

At start the plugin logs one line naming the roots it opened, the step that chose each, and whether the store is new, for example `agent-swarm: store /srv/dsh/agent-swarm/swarm.sqlite ($DSH_HOME), workspaces /srv/dsh/agent-swarm/workspaces ($DSH_HOME)`. When the store is new, was chosen by step 2 or 3, and a lower step of the same environment already holds one (`$DSH_HOME/agent-swarm` below a `DSH_AGENT_SWARM_ROOT`, or `~/.dsh/agent-swarm`), the same line names that store and the `DSH_AGENT_SWARM_ROOT` value that keeps it. It never moves or adopts that store: under an isolated home it belongs to another host. No other store is looked for: one under another non-default home, under a `DSH_AGENT_SWARM_ROOT` since dropped, or beside a configured `statePath` is never named, and the line only says the store is new. The line is logged at info, the threshold a log exporter uses by default; Cordis ranks a warning below info, so a warning would be dropped where the roots are shown. The 0.2.1-rc.2 Web and Desktop profiles mount no log exporter, so the line appears only where a profile mounts one, such as `@deepseek-ai/cordis-plugin-logger-console`, and neither the panel nor the store records it.

**Upgrading an install whose row left a root unconfigured.** Up to `ba9a758`, a root the composed plugin row did not configure was `~/.dsh/agent-swarm/…`, whatever `DSH_HOME` or `DSH_AGENT_SWARM_ROOT` said. The direct mount's row configures neither root. The bundle mount's row configured both, but a later layer that targets the row by id, such as a `--patch` overlay or the profile's own `cordis.patch.yml` adding `authorizedWorkspaces`, replaces the row's whole config, so a layer that did not restate both roots dropped them. If such an install ran with `DSH_HOME` naming another home, or with `DSH_AGENT_SWARM_ROOT` set, the rule now moves each unconfigured root out of `~/.dsh/agent-swarm`: an unconfigured `statePath` opens a new, empty store, and on a stock profile nothing says so (see the start line above). A bundle mount whose row kept its roots chose them as the rule does now, except under a blank, `~`-prefixed or relative value: its expression then named a relative root, which the plugin refused, or one at the filesystem root (`/agent-swarm/…`, or `/swarm.sqlite` for a blank `DSH_AGENT_SWARM_ROOT`). To keep the missions of an install that moved, stop the host and start it again with `DSH_AGENT_SWARM_ROOT` set to the old root (`~/.dsh/agent-swarm`), or configure both roots in a profile overlay (a Desktop started from the Dock takes no `DSH_*` value from the login shell). Do not move the files instead: member worktrees are registered with Git under their absolute paths. Do this only when that store is this host's own: if a host on the default home also uses `~/.dsh/agent-swarm`, it is that host's store, and its owner lock refuses a second live runtime. An install whose composed row configures both roots is unaffected, and since no shipped row carries a root any more, a layer that replaces the row's config no longer moves the store.

### Authorize another workspace

A mission may use the directory the calling session started in or a realpath inside a root in `authorizedWorkspaces`. A human edits the profile or `cordis.patch.yml` and restarts Harness to change these roots. No model-callable tool can add, widen or revoke them. A `working_directory` cd changes where that session's shells and file tools run, not this authorization: `/agent-swarm`, the swarm tools and browser drafts still bind to the directory the session started in.

The resolved workspace and matched grant are recorded durably. An unauthorized path returns `[workspace_not_authorized]` with the required correction. The runtime re-checks a mission's workspace with the admission rule (the calling session's own directory, else the most specific active configured root that contains it) before every worker start, workspace preparation, planning snapshot, draft launch, delivery and verification checkout. Removing a root and restarting therefore prevents new missions there and fences an existing mission at its next scheduling pass, with a blocked reason and an owner notice; the owner is woken once per plugin runtime (each Harness start or plugin reload) that finds the mission revoked. A root whose `expiresAt` passes while Harness runs, or a workspace that stops resolving, fences its missions the same way at the next pass. Adding or removing a nested root never fences a mission that another configured root still contains. Work resumed before the root is restored is fenced again.

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
| Provider quota, rate limit, availability or account sign-in failure | Classified outages preserve the attempt without spending recovery credit and never retire a member. The classes are `quota` (an exhausted API-key or DeepSeek account balance), `rate-limit`, `unavailable` and `credential` (a signed-out DeepSeek account, or an account token the provider refused; sign in again in Harness). A member whose start fails inside its recorded outage window (5 minutes) is probed once per window instead of every tick, and work leaving it prefers a live member outside an outage window. The primary agent is notified once per outage class on the member's open work; a classified error is not also reported as the member's failure. A model the DeepSeek account catalog refuses on the running Harness release (`MODEL_UNSUPPORTED`, `CLIENT_UPGRADE_REQUIRED`) is not an outage but a refusal of the member's own route; see the next row. |
| A member's route refuses its reasoning effort or model | A launch and `swarm_add_member` check each member's route before anything is created, and a browser save checks the routes a draft names: the route the worker will run (the primary conversation's current model, under the member's own `provider`, `model` and `reasoningEffort`) must resolve on the host, its provider must run its model on this Harness release, and its model must take the member's effort. A refused plan names every refused member, with the efforts its route accepts when the effort is refused (`member_reasoning_effort_unsupported`, `member_model_unsupported` for `MODEL_UNSUPPORTED` or `CLIENT_UPGRADE_REQUIRED`, `member_route_unavailable`); the primary agent repairs the plan and relaunches, and nothing is downgraded. A route that changes after admission refuses the member's next model step before any request: the member is retired at once (`member/route-refused`), its unpinned work returns to the board for a capable live member, and the primary agent receives one notice with the exits: admit a replacement with `swarm_add_member`, and move pinned work with `swarm_control` (`action: "amend"`, `changes.assigneeId`). |
| A worker cannot start | Each failed start re-pends the task without spending recovery credit. After 3 consecutive failures the member is retired and its work moves to another capable live member. When no live member can start a task any more, the primary agent receives one notice naming the task, each retired member with its consecutive start failures and last error, and the exits: admit a working member with `swarm_add_member` (it claims unpinned work), move pinned work with `swarm_control` (`action: "amend"`, `changes.assigneeId`), or withdraw it with `swarm_cancel`. The task stays pending and nothing retries it. |
| Rejected task leaves downstream work waiting | The primary agent can admit a replacement that retains the original acceptance criteria. Dependents resolve through the replacement after it is accepted. |
| Owner is offline or a native call is hung | Notices remain durable. The owner must become available and reach a native inbox boundary before acting; runtime cancellation is independent. Delivery is not a guarantee of an immediate model response. |
| Store is truncated or missing | The store fails closed and names its snapshot. The primary agent can stage one validated snapshot with `swarm_restore`; the next host start applies it before opening the store. |
| Check cannot find a command | A check that exits 126 or 127 in the clean verification checkout is recorded as `unrunnable` and defers its review; the reason names the dependency directories the checkout received. Provide what the command needs in the source project or on the host (inspect the installed toolchain and `verificationDependencyDirs`), then resume the review with `swarm_control`. If the command itself is wrong, cancel the source with `swarm_cancel` and propose its repair with `swarm_propose` naming `replaces`, the corrected `checks`, `maxRecoveryAttempts` and `checkTimeoutMs` (the allocations a launched mission's admission requires). The plugin does not install project dependencies for you. |
| Browser returns HTTP 401 | Use the authenticated launch URL from the running Harness profile. |
| Missing provider key | Configure the model route and credentials in Harness. The plugin has no separate API-key store. |

Verification runs the declared commands against the exact submitted commit. A failed command cannot be waived by an agent's success claim, but passing checks do not prove the commands cover every requirement. Ignored dependency directories are copied into verification checkouts by default; they are installed toolchain state, not a fresh CI install. Explicit link mode can expose reads through to the source checkout.

A declared check that decides no verdict defers the review instead of rejecting the artifact, and the host records why on the check row: `timeout` (the host's check deadline fired), `infrastructure` (the host could not prepare, confine or start the check, exit 125) or `unrunnable` (exit 126 or 127). A command's own exit 124, such as an inner `timeout`, is a failed assertion and rejects the artifact. The deferral names the kind's exit: raise the source's `checkTimeoutMs` with `swarm_budget`, repair the host condition the output reports, or provide what the command needs; then resume the same review with `swarm_control` (`action: "resume"`). When git cannot remove a disposable verification checkout, the host removes the tree itself and tries to drop its registration, the mission's next verification that runs declared checks reclaims whatever is left, and the `task/verification-cleanup-failed` owner notice says so; no `git worktree prune` is needed.

Copy mode supports a dependency directory that is itself a symlink and relocates links within that dependency. A link to an external regular executable, such as a virtualenv's Python interpreter, becomes a copied executable; system libraries may still be required. Broken links, links into other source checkout content, and links to external directories or non-executable data cannot be materialised: no declared command runs, the verification is recorded as an infrastructure failure (`(verification preparation)`, exit 125) and the review is deferred with the repair in its output (`verificationDependencyMode: "link"` with `allowDependencyLinkReads: true`, or `verificationDependencyDirs`); resume it with `swarm_control` once the host is configured. Use self-contained dependencies, or explicitly opt into external reads with both `verificationDependencyMode: link` and `allowDependencyLinkReads: true` in the host configuration.

Snapshot selection follows the current Git index: a file removed from the index and now ignored remains excluded even if HEAD previously tracked it. Capture checks the resulting private index against current file contents and retries detected changes; concurrent multi-file edits still cannot be treated as an atomic filesystem snapshot.

An invalid live update retains the last valid view and retries a full snapshot with backoff. Continued invalid data stays visibly disconnected rather than displaying invented progress. Owners can settle existing questions after pause, stop or completion without resuming workers. Trace metrics describe a bounded span window and expose its truncation explicitly; full durable records remain available separately.

Worker confinement follows the configured Harness sandbox. Each worker activation also starts the worker's session in its member worktree, since a session's working directory outlives a turn, and workers neither see nor may call the host tools that would move it or schedule a later turn: `working_directory`, `create_worktree` and the `schedule_*` reminder tools. Shared temporary directories remain a possible cross-member channel. Delivery Git subprocesses also retain the process-management exceptions described in [known limitations](known-limitations.md).

## Companion context policy

[dsh-slice-agent-loop](https://github.com/TT-Wang/dsh-slice-agent-loop) (`@dsh-external/dsh-slice-agent-loop`) is an optional companion for managing each session's retained context. Agent Swarm coordinates missions across workers; the slice policy manages history within each native session and provides `recall_turn`, `recall_search`, `recall_step` and `expand_result` to retrieve prior material. Context management does not change swarm acceptance, workspace or budget rules, and does not guarantee a particular cache hit rate or provider bill.

Mount the swarm and slice layers in the same profile using each project's installation instructions. Their tool names do not overlap. The slice package includes tool-result folding; do not add the standalone folding plugin beside it. Swarm storage still needs the explicit roots described above.

## Development and verification

The behavioral suite has two tiers, listed in `scripts/test-tiers.mjs`. The hermetic tier needs only the packages `package-lock.json` pins, which include the 0.2.1-rc.2 Harness packages from the npm registry, so a fresh clone runs it without a Harness checkout:

```sh
git clone https://github.com/TT-Wang/dsh-agent-swarm.git
cd dsh-agent-swarm
npm ci
npm test
```

It runs on every machine as that clone would: `DSH_HARNESS_ROOT` and `DSH_SOURCE` are removed and the search for a checkout is off, so a test that needs one fails there and belongs to the host tier. The host tier and the other gates need a built Harness 0.2.1-rc.2 checkout at the release commit. After `npm ci`, set `DSH_HARNESS_ROOT` and run `npm run link:dsh` (see [Build and install](#build-and-install)), then:

```sh
npm run verify
```

This runs typecheck, build, the behavioral suite, packaged-artifact loading, real Loader composition, CLI profile installation, the declarative bundle checks and both browser workflows.

| Command | Coverage |
| --- | --- |
| `npm test` | Build and the hermetic tier of the behavioral suite: every `tests/*.test.mjs` the host tier does not list. |
| `npm run test:faults` | Fault injection; each scenario must establish that its fault fired. |
| `npm run test:replay` | Deterministic replay over the durable log. |
| `npm run test:oracle` | The full-log oracle: the replay scenario and the clocked fault scenarios must leave the recorded events, rows and adapter call trace (`scripts/replay/oracle/`). |
| `npm run test:load` | Admission and scheduling under load. |
| `npm run test:isolation` | Host-only sandbox and workspace confinement. |
| `npm run test:harness` | Real Harness Loader composition. |
| `npm run test:pack` / `npm run test:packed` | Packaged-artifact loading and declared behavior. |
| `npm run test:profile` | Real CLI profile installation and lifecycle. |
| `npm run test:bundle` | The host tier of the behavioral suite (`tests/r17-profile.test.mjs`): bundle metadata, the empty-config plugin row both mounts insert, host composition, and the root rule and start line on real profile boots of both mounts. |
| `npm run test:web` / `npm run test:command-web` | Sidebar and `/agent-swarm` browser workflows. |

A package that `src/`, `tests/` or `scripts/` imports must be a devDependency at an exact version, and also a peer dependency when `src/` imports it; `tests/declared-dependencies.test.mjs` checks this and that `package-lock.json` matches `package.json`.

These suites use temporary profiles and Git workspaces with scripted provider responses. They establish integration behavior, not model planning success rates. `npm run test:deepseek` and `npm run test:command-deepseek` make real provider requests, can incur charges and are excluded from `verify`. Completed runs and their limits are recorded in [validation](validation.md).

The real Loader compositions (`test:harness`, `test:pack`, the fault suite's provider tier, and `test:deepseek`, `test:command-deepseek` and `scripts/check-cancel-freeze.mjs` on the DeepSeek API-key route) mount the running host's built packages; a package the checkout lacks fails the composition with its name, and every enabled row must be active after boot: a row still waiting for a service fails the boot and names that service. They mount `@deepseek-ai/dsh-fs-local` and `@deepseek-ai/dsh-working-directory` rooted at the test workspace; the working-directory service gives `bash` its directory. The DeepSeek route comes from `@deepseek-ai/dsh-llm-deepseek-api-key`.

The browser smokes (`test:web`, `test:command-web`) run the CLI web product with the scripted model as its only provider: they disable `llm-deepseek` and `llm-deepseek-account`. The default workspace the host opens on first use is created inside the run's temporary root, not in the operator's Documents folder.

## Revise estimates and recover the same work

The primary agent receives durable advance warnings for mission resources and task steps/findings, including estimates for in-flight model requests. Warnings do not change task shape. `swarm_budget(missionId, taskId, taskBudget, reason)` updates finite task allocations; omit `taskId` and supply `budget` to update the mission. Used steps/tokens, task identity and artifacts stay intact. A resource-only wait continues after the extension and stop confirmation; an explicit user pause still needs resume. Findings are advisory; an explicit user stop remains in force.

`swarm_control(missionId, taskId, action: "amend", changes, reason)` corrects unsubmitted scope, dependencies, checks or assignee. `action: "resume"` retries the same task after a preparation or check-environment repair. Review retries keep the exact submitted artifact; failed assertions still need a corrected implementation and independent review. Running work is reassigned only after its worker stop and workspace preservation finish. A review blocked on its deferred or rejecting verdict holds an attempt that ended with that verdict, so its resume or reassignment stops no worker and re-pends it at once. Its next attempt starts from the review record that verdict captured, never from the previous reviewer's worktree; a reworked task given to another member likewise starts from its rejected commit. A reassigned review recovers saved drafts only for the same immutable source; its new reviewer must independently inspect the pinned source and cite fresh tool evidence. Host checks still use a fresh exact-artifact checkout.

Integration workers can resolve listed files in `.swarm-integration-conflicts.json` using ordinary edits, then remove that manifest and submit. The host retains accepted dependency commits and checks the final scoped artifact. Unknown script names or inferred prose paths are planning hints; actual authorization, scoped writes, check execution and independent review remain enforced. Failed saved plans can be edited and relaunched without discarding their request, snapshot, admitted work or recorded consumption.

A mission cannot complete while required synthesis or review work remains unfinished, even if accepted deliverables already cover every mission criterion. A stranded task stays recoverable and notifies the primary; amend its dependencies or assignee in place. Withdraw obsolete work explicitly with `swarm_cancel`. Completion itself never cancels tasks.

Check-environment records distinguish the configured `dependencyLinks.dirs` set from the actual relative `materializedPaths` found for that execution. Directory ordering and absent optional dependency folders do not change the configured policy; real policy-set or copy/link-mode changes still reject a mismatched verification.

## Recovering orchestration issues

Amend a stale dependency list on the existing task before creating a duplicate deliverable. `changes.dependencies` replaces the entire list; the response includes added and removed dependencies. Cancelling a prerequisite reports `strandedDependents`. Replacements must continue the live repair chain, rather than fork an ancestor with an active or accepted descendant.

A stop must finish and preserve the previous attempt before its member workspace can be reused. A timed-out queue wait returns an actionable refusal without running overlapping workspace operations. The owner can still pause, stop, inspect and work on other missions. Deterministic preservation failures retain the fence and emit one decision notice per task/epoch/cause; after repairing the reported condition, `swarm_control(action: "resume", taskId, reason)` retries cleanup even for a cancelled task without reviving it.

Named in-scope ignored output files are included in private recovery checkpoints. Unlisted ignored files are not collected: a conflicting workspace switch refuses and reports the paths. `swarm_verify.deliverables` optionally captures a separate review report in immutable blobs; the verdict remains durable when no report file is requested. The source artifact and its host checks remain pinned to the original commit.

Budget warnings include task slots needed for known unpaired reviews. `suggestedLimit` restores warning headroom only; the primary must consider remaining work and actual progress before choosing a new ceiling. A delivery marked queued is not proof of worker receipt: failed transports appear in the compact member view and wake the primary. Owner reminders are checked again when the host admits them into context, so stopped work, answered questions and superseded budget warnings do not cause an extra decision turn. Already consumed historical messages remain in the session log.
