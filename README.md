# Agent Swarm for DeepSeek Harness

Turn a natural-language task into a team of collaborating agents inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

```text
/agent-swarm 为这个项目添加搜索功能，保留现有接口，并验证相关测试通过。
```

The primary agent inspects the project, chooses the team and resource budgets, and launches the work. Workers can propose tasks, ask peers, share evidence, challenge results and hand off partial implementations. A durable runtime coordinates their work and requires independent review before accepting a deliverable.

**Version 0.6.0 · MIT · Local Git workspaces · Native DSH Web sidebar**

## What you get

- **One command to start.** `/agent-swarm` appears in native command autocomplete. Describe the outcome; the primary agent plans and launches without a configuration form.
- **A sidebar beside your conversation.** See the goal, current activity, accepted work and recent progress first. Expand team and technical details when needed. Use a Better Sidebar tab when available, or the built-in dock.
- **Real Harness workers.** Each worker has its own native agent, session, inbox, tools and sandbox. Open live conversations or read persisted worker transcripts.
- **Agent-selected resource limits.** The primary chooses token and step budgets, team capacity, task and experiment limits, mission duration, model routes, output-token allowances, recovery attempts and verification timeouts. It can revise budgets with a recorded reason while preserving usage.
- **Durable collaboration.** SQLite coordination state, attempt fencing, retained worktrees and recoverable peer messages support restart and handoff.
- **Independent acceptance.** Code submissions become immutable Git artifacts. Another worker reviews them, and the host runs declared verification commands in a fresh checkout of the submitted commit.

This is an external Harness plugin. It does not require a fork or changes to Harness core.

## Compatibility

The following exact Harness releases were validated on **2026-09-08**:

| Harness release | Release commit | Distribution on that date |
| --- | --- | --- |
| [0.1.2-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1) | `a66e4702047846cdaa10c66c9d3df3951f5ea70d` | npm `latest` / `next` |
| [0.1.3-alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.2) | `82a5fd61a7cf5c293cec4bdff68f455398d685e9` | npm `alpha`; newest GitHub release |

Both are prereleases. This plugin does not claim compatibility with the old `0.1.0-rc.5` SDK or with newer unreleased Harness commits. The development linker checks the release revision in [compatibility.json](compatibility.json), not just its version string.

The supported releases have passed packaged-artifact loading, native CLI profile installation and the native `/agent-swarm` browser workflow; the exact tested builds and behavioral totals are recorded in the validation document. Provider responses were scripted while Harness, tools, persistence, Git effects, authentication and browser interactions were real. These checks establish integration behavior, not model planning success rates. See [validation](docs/validation.md) for the exact matrix and its limits.

## Install from source

You need:

- Node.js `^22.19.0 || >=24.0.0`, Git and a POSIX system such as macOS or Linux. Windows execution is currently unsupported.
- A checkout of one of the exact Harness releases above, with its dependencies installed and its CLI and Web application built. Follow the [Harness development instructions](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.2/docs/development.md) for the selected release.
- A working Harness model/provider configuration. Configure API credentials through Harness; the plugin uses the owner conversation's model configuration by default.

Clone this plugin, point it at the built Harness checkout, and build:

```sh
git clone https://github.com/TT-Wang/dsh-agent-swarm.git
cd dsh-agent-swarm

export DSH_HARNESS_ROOT="/absolute/path/to/deepseek-harness"
npm run link:dsh
npm run build
```

`link:dsh` links dependencies from that Harness checkout, including its shared runtime packages and build tools. This source workflow does not require a separate `npm install` in the plugin directory.

`npm pack` and `npm publish` rebuild `lib/` through the `prepack` hook, so packing a clean checkout ships the declared entry points instead of an empty `lib/` directory. The hook writes build progress to stderr, so `npm pack --json` output stays machine-readable.

Install the built directory into the Web profile using the **matching Harness CLI**:

```sh
node "$DSH_HARNESS_ROOT/apps/cli/lib/bin.js" plugin --profile web add "link:$PWD"
```

Start or restart that profile from your project:

```sh
cd /absolute/path/to/your-project
node "$DSH_HARNESS_ROOT/apps/cli/lib/bin.js" --profile web
```

Open the authenticated launch URL provided by Harness. Its native login exchange establishes the browser cookie; opening a bare unauthenticated URL can return HTTP 401. The plugin adds mission/session ownership checks to Harness's existing authentication.

Keep the linked plugin directory available. After rebuilding it, restart the profile and refresh the browser. If you run different Harness versions concurrently, use separate plugin checkouts or built copies linked to each version. Relinking one shared development directory changes the packages used by every host pointing at it.

These instructions install a local source build. They do not require or imply a published npm package.

## Use it

Open a conversation in a **Git workspace**, choose your model in Harness, then send a task:

```text
/agent-swarm Add search to this project, preserve the existing API, and verify the relevant tests pass.
```

```text
/agent-swarm 修复登录后偶尔跳回登录页的问题。先定位原因，再实现修复，补充回归测试并独立验证。
```

```text
/agent-swarm 审查这个项目的缓存逻辑，找出可能导致过期数据的问题，提交带证据的分析报告，本次不要修改代码。
```

The primary agent chooses the plan and budgets from the task. The sidebar shows planning, launch and progress; automatic missions complete after their required independent acceptance. You do not need to enter worker counts, token limits or step counts, or manually press Launch and Complete.

Use **Pause** and **Resume** beside the progress summary in the owner conversation. **Stop** is inside **Task details and resources** and asks for a second click. Hiding the sidebar pauses its display updates, not the workers. If more resources are needed, ask the primary agent to reassess the budget and resume; increasing a budget alone does not resume a paused mission, and it does not reset consumption. The duration limit is measured from mission creation, including time spent paused.

Before planning, the plugin freezes the project's saved files into a private Git snapshot. Tracked changes and non-ignored new files are included; your branch, real index and working files stay as they are. No manual commit is needed. The primary is directed to inspect a frozen planning checkout and every worker starts from the same snapshot, including after restart. Later source edits do not change that baseline. Unresolved merge conflicts, dirty submodules and unsupported repository layouts produce a specific error instead of silently omitting work. Git objects, worktree metadata and plugin refs are retained for recovery.

For code work, the deliverable is an independently accepted **integration commit and its worktree**, or the single independently accepted implementation commit when the plan needed no assembly step. The completed mission's sidebar offers **View changes** and **Apply result**. Both use the project snapshot as their baseline, so your pre-existing changes are not counted as swarm output. Applying merges the result with current working files while preserving your branch and index. Conflicts are reported before any source file is changed. It does not stage, commit or push the result; retained artifacts remain available for inspection.

## Sidebar

With **Better Sidebar** installed, choose **Agent Swarm** from its **+** tab menu. The integration uses its public tab service, including per-tab conversation scope and visibility. Pinned tabs retain their own session context.

Without Better Sidebar, a resizable dock sits beside the conversation. Collapse and reopen it from the Agent Swarm rail; its width is remembered. Narrow screens place the panel below the conversation. Principal labels follow Harness's English/Chinese setting and light/dark theme.

The default view shows the mission goal, current work, accepted-task count and recent progress. **Team** reveals worker conversations. **Task details and resources** reveals budgets, the work board, dependency graph, evidence and event history. The four technical tabs and resource metrics are collapsed initially.

Activity labels come from native model requests, tools, verification and provider retry events. Elapsed time counts from the observed operation's actual start while the panel is connected. These labels describe what the host has observed; an active request is not a promise that the model is making useful progress. On a connection failure the panel shows **Reconnecting** and marks retained activity as the last observed state.

The panel receives committed changes through a cancellable native RPC watch, with periodic connection keepalives. Hiding a pane stops its requests; reopening fetches current state. Reconnection uses a durable cursor and requests a full snapshot when the retained change history cannot fill a gap. **Open conversation** navigates to a listed worker's native chat; after disposal it opens a read-only, paginated transcript without activating an agent or making a model request. Conversation cards remain historical snapshots.

An **Advanced: configure a mission** disclosure remains available for explicit manual planning. It supports saved drafts, model choices and task graphs. Saving a draft does not start workers. The natural-language command is the normal entry point.

## How collaboration works

1. The primary agent supplies a complete mission plan: objective, scope, acceptance criteria, budgets, members, workstreams and a task graph.
2. The runtime validates the plan before dispatch. Workers can propose additional work within the mission, exchange attributed peer messages and publish evidence tied to host-recorded tool executions.
3. Workers submit immutable artifacts. Independent reviews begin when their source is submitted; ordinary dependencies unlock only after acceptance. A failed host check cannot be overridden by an agent's claimed pass.
4. Challenges reopen affected results and invalidate dependent work. Handoffs checkpoint partial work and stop the previous attempt before a replacement can proceed.
5. Accepted code artifacts converge through an integration task. Automatic completion requires accepted deliverables and coverage of the mission's acceptance criteria.

Peer messages never grant authority to expand scope or budgets, change ownership, or waive review. Coordination rules live in the runtime; lifecycle and sandbox behavior use native Harness services. See [design traceability](docs/design.md) for the implementation map.

## Storage and multiple hosts

The plugin's Loader row is `dsh-external-agent-swarm`. Infrastructure settings are defined in [src/index.ts](src/index.ts); the defaults include:

| Setting | Default |
| --- | --- |
| `statePath` | `~/.dsh/agent-swarm/swarm.sqlite` |
| `workspacesRoot` | `~/.dsh/agent-swarm/workspaces` |
| `leaseMs` | `120000` |
| `tickMs` | `1000` |

Only one live runtime may own a database. For independent Harness processes, configure distinct absolute `statePath` and `workspacesRoot` values through each profile's configuration overlay. **Changing `DSH_HOME` alone does not isolate this plugin's default storage.**

The live-update implementation upgrades the SQLite schema from version 1 to version 2 and retains existing missions. Save a consistent database backup before upgrading an existing installation if you need to return to an older plugin build: older builds reject the upgraded schema. Restore the pre-upgrade database or use a separate state path when downgrading; retain the corresponding workspaces and refs.

The infrastructure settings and manual editor defaults do not replace the primary agent's decisions. Automatic plans must supply their complete resource budgets and task policies.

## Development and verification

After linking the selected Harness checkout:

```sh
npm run typecheck
npm test
npm run test:harness
npm run test:pack
npm run test:profile
npm run test:web
npm run test:command-web
```

The test files import the built `lib/` output. `npm test` builds it first; a bare `node --test tests/*.test.mjs` needs `npm run link:dsh` and `npm run build` first, otherwise it stops at `ERR_MODULE_NOT_FOUND .../lib/runtime.js`. A clean checkout without linked dependencies stops earlier at `tsc: command not found`.

`test:harness`, `test:pack` and `test:profile` compose a real Harness profile whose sandbox requests `workspace-write`, so they need a host that permits nested `sandbox_apply`. Inside an outer workspace-write sandbox, macOS denies it (`sandbox-exec: sandbox_apply: Operation not permitted`) and the composition fails with `SandboxUnavailableError`. `test:pack` and `test:profile` detect an unusable nested sandbox before the composition and abort with that prerequisite; set `DSH_SWARM_SKIP_SANDBOX_PREFLIGHT=1` to attempt it anyway. `test:harness` reports the same error directly.

`test:web` and `test:command-web` launch the real Web application and are load-sensitive. Run them sequentially on an idle host and re-run a timeout before treating it as a product defect.

`npm run verify` runs those checks together. Browser checks require the built Harness Web app, its installed Playwright package and Google Chrome by default. To use an installed Playwright Chromium browser instead, set `DSH_SMOKE_BROWSER=chromium`. The suites use temporary profiles and Git workspaces; the model boundary is scripted. Test output and local browser evidence are written under the ignored `artifacts/` directory.

Optional checks include `npm run test:sidebar-service` against an installed Better Sidebar service (`DSH_BETTER_SIDEBAR_ROOT` can select its directory), and `npm run test:validation-repair-web` for same-request repair of an invalid plan. The `test:deepseek` and `test:command-deepseek` scripts make real provider requests and can incur API charges; they are excluded from `verify`.

## Current limitations

- **Local, single-host operation.** Git workspaces and POSIX process groups are required. Distributed workers and non-Git workspaces are not implemented.
- **Budget accounting has boundaries.** Worker tokens use reported provider usage. Requests still streaming are estimated at their worker's average per-request usage before a new step is admitted, which reduces but does not eliminate overruns. Usage that was never durably reported cannot be reconstructed. The primary conversation's own usage is attributed to its newest live mission by time window and shown separately; it is not charged to the worker pool, and it cannot be split across several concurrent missions of one owner.
- **Context efficiency depends on host services.** Sessions see only the swarm tools and prompt for their role, workers receive focused observations and their run ids inline, and routine progress no longer wakes the primary agent. History compaction at task boundaries uses the host compaction engine when one is loaded; without it, a worker's context keeps growing until the host's own pressure threshold. Verification checkouts make the source project's ignored dependency directories (`node_modules` by default) available to declared checks so they find their toolchain. Those directories are not part of the artifact and a check must treat them as read-only: a write through them may fail rather than modify the source, and results can depend on the installed toolchain state.
- **Task specifications determine verification quality.** The host proves that declared commands ran against the submitted artifact. It cannot infer a complete test oracle from natural-language requirements; mission-level acceptance checks remain an area for improvement.
- **Confinement follows the configured Harness sandbox.** Artifact capture checks changed paths against declared scopes. The plugin does not add independent network/credential isolation or adversarial multi-user isolation. Its tool restriction list is not a complete boundary for scheduling tools or other external side effects. Pre-launch read-only planning is a prompt instruction, not an OS write barrier.
- **Recovery still has open work.** Attempt leases renew only while the adapter can identify a live, uncancelled native operation, within the mission deadline. This does not detect every unproductive or stuck request; provider/tool timeouts and resource limits still matter. Outbox failure visibility needs further work, and delivery recovery does not guarantee exactly-once external side effects. Retained worktrees and refs require explicit cleanup.
- **Completion can cancel dead leftovers.** When every acceptance criterion is independently covered and the remaining tasks can never be scheduled (dead prerequisites, unreachable review sources, blocked work without a repair), the owner's **Complete** and automatic completion cancel those tasks and record why. A dispute on evidence that still supports accepted work continues to block completion.
- **Some views are intentionally limited.** Live updates reconcile committed mission snapshots; they are not token-by-token model streaming or distributed synchronization. Cold worker history displays text and tool records rather than the complete native chat interface; media appears by type and individual entries are capped with a truncation notice. Listed native worker chats may retain a writable composer, while mission controls remain owner-only.
- **Compatibility is bounded by the tested compositions.** Better Sidebar's public service integration was exercised against installed version 0.18.0. That does not establish compatibility with every other plugin or arbitrary custom Harness profile.

See [known limitations](docs/known-limitations.md) for the remaining review findings and their practical impact.

## Design sources and license

The collaboration design was informed by [METR's incident investigation](https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/). That report is design context, not a performance benchmark or endorsement of this plugin.

[dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) provided reference packaging, UI and reliability designs. This project implements a new collaboration runtime with participant proposals, durable evidence, challenges and independent artifact acceptance. Harness integration patterns also draw on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Licensed under the [MIT License](LICENSE). See [NOTICE](NOTICE) for retained upstream attribution and license notices.
