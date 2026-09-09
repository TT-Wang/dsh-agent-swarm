# Agent Swarm for DeepSeek Harness

Turn a natural-language task into a team of collaborating agents inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

```text
/agent-swarm 为这个项目添加搜索功能，保留现有接口，并验证相关测试通过。
```

The primary agent inspects the project, chooses the team and resource budgets, and launches the work. Workers propose tasks, ask peers, publish evidence, challenge results and hand off partial implementations. A durable runtime coordinates them and requires independent review before anything is accepted.

**Version 0.7.0 · MIT · Local Git workspaces · Native DSH Web sidebar**

## What you get

- **One command to start.** `/agent-swarm` appears in native command autocomplete. Describe the outcome; the primary agent plans and launches without a configuration form.
- **A sidebar beside your conversation.** The goal, current activity, accepted work and recent progress come first; team and technical details expand on demand. Uses a Better Sidebar tab when available, or the built-in dock.
- **Real Harness workers.** Each worker is a native agent with its own session, inbox, tools and sandbox. Open a live worker conversation, or read its persisted transcript after it finishes.
- **Independent acceptance, not self-assessment.** Code submissions become immutable Git commits. A different worker reviews each one, and the host runs the declared verification commands in a fresh checkout of the submitted commit. A failed command cannot be overridden by an agent claiming success.
- **Verification that can actually run your checks.** The clean checkout is given your project's installed dependency directories, so `npm test`, `pytest` and friends find their toolchain instead of failing with "command not found".
- **Visible cost.** Token usage is reported in disjoint buckets — uncached input, cache read, cache write, output (with its reasoning share) and physical request count — per worker and per mission, with the primary conversation's own usage shown separately.
- **Agent-selected resource limits.** The primary chooses token and step budgets, team size, task and experiment limits, mission duration, model routes, per-worker output allowances, recovery attempts and verification timeouts, and can revise them later with a recorded reason without resetting usage.
- **Durable collaboration.** SQLite coordination state, attempt fencing, retained worktrees and recoverable peer messages survive restarts, handoffs and worker failures.

This is an external Harness plugin. It needs no fork of, and no changes to, Harness core.

## Compatibility

The following exact Harness releases are supported:

| Harness release | Release commit | Distribution |
| --- | --- | --- |
| [0.1.2-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1) | `a66e4702047846cdaa10c66c9d3df3951f5ea70d` | npm `latest` / `next` |
| [0.1.3-alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.2) | `82a5fd61a7cf5c293cec4bdff68f455398d685e9` | npm `alpha`; newest GitHub release |

Both are prereleases. This plugin does not claim compatibility with the older `0.1.0-rc.5` SDK or with unreleased Harness commits. The development linker checks the release revision recorded in [compatibility.json](compatibility.json), not just a version string.

Verification runs against packaged-artifact loading, native CLI profile installation and the real `/agent-swarm` browser workflow. Provider responses are scripted while Harness, tools, persistence, Git effects, authentication and browser interaction are real, so these checks establish integration behavior — not model planning success rates. See [validation](docs/validation.md).

## Install from source

You need:

- Node.js `^22.19.0 || >=24.0.0`, Git, and a POSIX system such as macOS or Linux. Windows execution is unsupported.
- A checkout of one of the exact Harness releases above, with dependencies installed and its CLI and Web application built. Follow the [Harness development instructions](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.2/docs/development.md) for that release.
- A working Harness model/provider configuration. Credentials are configured in Harness; the plugin uses the owner conversation's model by default.

```sh
git clone https://github.com/TT-Wang/dsh-agent-swarm.git
cd dsh-agent-swarm

export DSH_HARNESS_ROOT="/absolute/path/to/deepseek-harness"
npm run link:dsh
npm run build
```

`link:dsh` links dependencies from that Harness checkout, including its shared runtime packages and build tools; no separate `npm install` is needed in the plugin directory.

Install the built directory into the Web profile with the **matching Harness CLI**:

```sh
node "$DSH_HARNESS_ROOT/apps/cli/lib/bin.js" plugin --profile web add "link:$PWD"
```

Start that profile from your project:

```sh
cd /absolute/path/to/your-project
node "$DSH_HARNESS_ROOT/apps/cli/lib/bin.js" --profile web
```

Open the authenticated launch URL Harness prints. Its login exchange sets the browser cookie; a bare unauthenticated URL returns HTTP 401. The plugin adds mission and session ownership checks on top of Harness's own authentication.

Keep the linked plugin directory in place. After rebuilding it, restart the profile and refresh the browser. If you run several Harness versions at once, link a separate checkout or built copy to each — relinking one shared directory changes the packages every host loads.

These instructions install a local source build; they do not require a published npm package.

## Use it

Open a conversation in a **Git workspace**, choose your model, then describe the task:

```text
/agent-swarm Add search to this project, preserve the existing API, and verify the relevant tests pass.
```

```text
/agent-swarm 修复登录后偶尔跳回登录页的问题。先定位原因，再实现修复，补充回归测试并独立验证。
```

```text
/agent-swarm 审查这个项目的缓存逻辑，找出可能导致过期数据的问题，提交带证据的分析报告，本次不要修改代码。
```

You do not enter worker counts, token limits or step counts, and you do not press Launch or Complete. The primary agent plans from the task, and the mission completes automatically once the required independent acceptances are in.

**Before planning, your project is frozen into a private Git snapshot.** Tracked changes and non-ignored new files are included; your branch, index and working files are untouched, and no manual commit is needed. The primary agent inspects a frozen planning checkout, and every worker — including after a restart — starts from that same snapshot, so later edits to your source never change the baseline. Unresolved merge conflicts, dirty submodules and unsupported layouts produce a specific error rather than silently omitting work.

**Controls.** **Pause** and **Resume** sit beside the progress summary; **Stop** is inside *Task details and resources* and asks for a second click. Hiding the sidebar pauses its display, not the workers. Raising a budget does not by itself resume a paused mission and never resets consumption; mission duration is wall-clock from creation, including time spent paused.

**When something goes wrong.** The primary agent is told only when a decision is needed — a rejected review, a challenged finding, a worker failure, an approaching or exhausted budget, a board where nothing can be scheduled, or completion. It can withdraw admitted-but-mistaken work, repair blocked work with a replacement task that keeps the original acceptance criteria, or raise a ceiling with a recorded reason. Accepted work is immutable: it is replaced, never edited.

**The deliverable** for code work is an independently accepted commit and its worktree — the final integration, or the single reviewed implementation when the plan needed no assembly step. A completed mission's sidebar offers **View changes** and **Apply result**, both measured against the project snapshot so your pre-existing edits are never counted as swarm output. Applying merges into your working files while preserving your branch and index, reports conflicts before changing anything, and does not stage, commit or push.

## How verification works

A submitted artifact is a real Git commit. To accept it, the host:

1. creates a fresh worktree at exactly that commit — not the worker's directory, and not your source checkout;
2. links your project's installed dependency directories (by default `node_modules`, `.venv`, `venv`, `vendor` and `.tox`, at any depth) into that checkout, so declared checks find their toolchain;
3. runs each declared command with the task's timeout, inside the Harness sandbox;
4. validates the artifact's changed paths against the task's declared scope, separately from the commands.

Any non-zero exit rejects the artifact. A command that is not found reports that it was an environment failure rather than a defect in the work, so a reviewer does not retry the same artifact blindly.

If your project keeps its toolchain in other directories, name them in `verificationDependencyDirs`; the configured list replaces the default set, and `[]` disables materialisation. Use `verificationDependencyMode: "copy"` when a read-through symlink is not acceptable; `link` is the default and is cheaper.

## Resource limits and cost

Budgets are chosen by the primary agent and enforced by the runtime across the whole team.

- **Token accounting is bucketed.** Uncached input, cache read, cache write, output (including its reasoning share) and physical request count are recorded per worker and per mission. The sidebar shows the breakdown under *Task details and resources*.
- **Cached input is charged at a discount.** Cache reads count toward the budget at `cacheReadWeight` (default `0.1`) while the raw buckets stay exact, so a cache-heavy review is not throttled at roughly ten times its real cost. Displayed volume and charged cost are therefore different numbers, deliberately.
- **The primary conversation's own usage is tracked separately** and attributed to its mission, but is not charged against the worker pool.
- **Warnings arrive before exhaustion.** The primary agent is notified as each dimension crosses `budgetWarnAt` (default `0.7` and `0.9`), and an exhausted mission names which dimension ran out.
- **A step is refused when the pool is already committed.** Requests still streaming are estimated at each worker's average, so an in-flight burst is less likely to overshoot the ceiling.

## Sidebar

With **Better Sidebar** installed, pick **Agent Swarm** from its **+** tab menu; per-tab conversation scope and visibility are respected, and pinned tabs keep their own session.

Without it, a resizable dock sits beside the conversation — collapse and reopen from the Agent Swarm rail, and its width is remembered. Narrow screens move the panel below the conversation. Labels follow Harness's English/Chinese setting and light/dark theme.

The default view leads with the goal, current work, accepted-task count and recent progress. **Team** reveals worker conversations. **Task details and resources** reveals budgets, the usage breakdown, the work board, the dependency graph, evidence and event history.

Activity labels come from real model requests, tool executions, verification runs and provider retries. Elapsed time counts from the operation's observed start. These describe what the host has seen — an active request is not a promise of useful progress. On a connection failure the panel shows **Reconnecting** and marks retained activity as last-observed.

Updates arrive through a cancellable native RPC watch with keepalives; hiding a pane stops its requests and reopening fetches current state. **Open conversation** navigates to a live worker's native chat, or opens a read-only paginated transcript after that worker is gone — without activating an agent or spending a model request.

An **Advanced: configure a mission** disclosure remains available for explicit manual planning with saved drafts, model choices and task graphs. Saving a draft starts no workers. The natural-language command is the normal entry point.

## How collaboration works

1. The primary agent supplies a complete plan: objective, scope, acceptance criteria, budgets, members, workstreams and a task graph. The runtime validates it before any worker starts and returns every field problem at once so one repair fixes the whole plan.
2. Workers propose further work inside the mission, exchange attributed peer messages, publish evidence tied to host-recorded tool executions, and post typed notes to the sanctioned mission board (`swarm_post`, read back with `swarm_board`). Every tool result a worker receives carries the host's own run id, so a claim can cite it.
3. Work is submitted as an immutable artifact. Independent review starts as soon as the source is submitted; ordinary dependencies unlock only after acceptance. A review is never assigned to the author of the work it reviews.
4. A challenge reopens the affected result and invalidates whatever depended on it. A handoff checkpoints partial work and stops the previous attempt before a replacement can begin.
5. Blocked work is repaired by a replacement task that carries the original acceptance criteria. **Dependents follow the repair automatically** — a task that depended on the rejected original becomes ready when the accepted replacement lands, and is built against the replacement's artifact.
6. A mission completes when independently accepted work covers every acceptance criterion. If the board reaches a state where nothing can ever be scheduled again, the primary agent is told once, with the specific tasks that are stuck.

Peer messages never grant authority to widen scope or budgets, change ownership, or waive review. Coordination policy lives in the runtime; lifecycle and sandboxing use native Harness services. See [design traceability](docs/design.md).

## Storage and configuration

The plugin's Loader row is `dsh-external-agent-swarm`. Settings are defined in [src/index.ts](src/index.ts):

| Setting | Default | Purpose |
| --- | --- | --- |
| `statePath` | `~/.dsh/agent-swarm/swarm.sqlite` | Coordination state. One live runtime per file. |
| `workspacesRoot` | `~/.dsh/agent-swarm/workspaces` | Snapshots, worker worktrees, verification checkouts. Must be outside your source repository. |
| `verificationDependencyDirs` | `["node_modules", ".venv", "venv", "vendor", ".tox"]` | Installed dependency directories made available to verification checkouts. |
| `verificationDependencyMode` | `"link"` | `link` symlinks them read-through; `copy` clones them per checkout. |
| `cacheReadWeight` | `0.1` | Budget weight for cached input. Raw buckets are unaffected. |
| `budgetWarnAt` | `[0.7, 0.9]` | Fractions at which the primary agent is warned per dimension. |
| `checkTimeoutMs` | `60000` | Fallback per-command timeout when a task does not choose one. |
| `leaseMs` | `120000` | Attempt lease, renewed only while a real operation is observed. |
| `tickMs` | `1000` | Scheduler tick. |

Only one live runtime may own a database. To run independent Harness processes, give each an absolute `statePath` and `workspacesRoot` through its profile overlay. **Changing `DSH_HOME` alone does not isolate this plugin's storage.**

Infrastructure settings never replace the primary agent's decisions: an automatic plan must still supply its own complete resource budgets and task policies.

## Development and verification

After linking a Harness checkout:

```sh
npm run verify
```

That runs typecheck, build, the behavioral suite, packaged-artifact loading, real Harness Loader composition, CLI profile installation, and the two browser workflows. Individual suites:

| Command | What it covers |
| --- | --- |
| `npm test` | The full behavioral suite against the built artifact. |
| `npm run test:faults` | Fault injection — each scenario must first prove its fault actually fired. |
| `npm run test:replay` | Deterministic replay over the durable log. |
| `npm run test:load` | Admission and scheduling under load. |
| `npm run test:isolation` | Sandbox and workspace confinement (host-only). |
| `npm run test:harness` | Real Harness Loader composition, end to end. |
| `npm run test:pack` / `test:packed` | The packaged artifact loads and runs what it declares. |
| `npm run test:profile` | Real CLI profile install and lifecycle. |
| `npm run test:web` / `test:command-web` | The sidebar and `/agent-swarm` browser workflows. |

Suites use temporary profiles and Git workspaces, with the model boundary scripted. `test:deepseek` and `test:command-deepseek` make real provider requests, can incur charges, and are excluded from `verify`.

## Current limitations

- **Local, single-host.** Git workspaces and POSIX process groups are required. Distributed workers and non-Git workspaces are not implemented.
- **Verification proves that your commands ran, not that they are sufficient.** The host executes exactly what a task declares, against the exact submitted commit. It cannot infer a complete test oracle from a natural-language goal.
- **The verification checkout borrows your installed toolchain.** Linked dependency directories come from your working copy, so they are not a fresh install and may differ from CI.
- **Budget accounting is provider-reported.** In-flight requests are estimated, so an unusually large one can still cross a ceiling. Attempts that report no usage cannot be counted.
- **Confinement follows the configured Harness sandbox.** Artifact capture checks changed paths against declared scopes. The plugin adds no independent network or credential isolation, and its tool restrictions are not a complete boundary for every side-effecting tool.
- **Recovery is bounded.** Attempt leases renew only while a live operation is observed, within the mission deadline; this does not detect every stuck request. Retained worktrees and Git refs require explicit cleanup.
- **Views are deliberately limited.** Live updates reconcile committed state rather than streaming tokens. Cold worker history is a text and tool-record projection, with media shown by type and long entries truncated.
- **Compatibility is bounded by the tested compositions.** Better Sidebar integration was exercised against version 0.18.0; that does not establish compatibility with every other plugin or custom profile.

See [known limitations](docs/known-limitations.md) for the detailed list.

## Design sources and license

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Design traceability is recorded in [docs/design.md](docs/design.md); the tested matrix and its limits in [docs/validation.md](docs/validation.md).
