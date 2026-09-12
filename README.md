# Agent Swarm for DeepSeek Harness

Turn a natural-language task into a team of collaborating agents inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

```text
/agent-swarm 为这个项目添加搜索功能，保留现有接口，并验证相关测试通过。
```

One command starts a mission. The primary agent inspects the project, chooses the team and the resource budgets, and launches the work; workers propose tasks, ask peers, publish evidence, challenge results and hand off partial implementations. A durable runtime coordinates them, and nothing is accepted without an independent review of the exact artifact.

**Version 0.7.0 · MIT · Local Git workspaces · Native DSH Web sidebar**

## Positioning

Agent Swarm is DSH's **mission layer**: the part of the platform that turns one
instruction into bounded, isolated, independently verified work.

DSH already owns the agent layer — the model loop, sessions, the inbox, the tool
surface, the sandbox, approvals, the durable session log and telemetry — and this
plugin never re-implements any of it. What DSH does not provide is coordination:
who does what, under which limit, against which baseline, verified by whom, and
who has to decide when the work stops moving. That is what this plugin adds,
without forking Harness core and without patching it.

Stated as what a caller may rely on:

- **One specification in, one artifact plus evidence out.** A mission
  specification — objective, scope, acceptance criteria, dependency graph,
  budgets, workspace — produces a committed artifact, a non-author verdict,
  host-recorded check runs and a durable record.
- **One owner decision loop.** The owner is told when a decision is needed — a
  submission to review, a blocked or unreviewable task, a challenged finding, an
  exhausted ceiling, a board that cannot advance — not on every tick. A mission
  is not an unattended black box.
- **Failures are facts with exits.** Every refusal on a model-facing path carries
  a stable bracket code and an executable next step, such as
  `[workspace_not_authorized]`, `[workspace_uncommitted]` or
  `[verification_requires_verify]`; a non-terminal state always has a recorded
  successor or a bounded escalation.
- **Resources are accounted and bounded.** Tokens, steps, wall time, tasks,
  experiments and check concurrency are owner-set, are never silently exceeded,
  and are never reset by a resume.

## Features

- **One command to start.** `/agent-swarm` appears in native command autocomplete. Describe the outcome; the primary agent plans and launches without a configuration form.
- **A sidebar beside your conversation.** Goal, current activity, per-worker progress, accepted-work count and recent progress come first; budgets, the work board, the dependency graph, evidence and the event history expand on demand.
- **Real Harness workers.** Each worker is a native agent with its own session, inbox, tools and sandbox. Open a live worker conversation, or read its persisted transcript after it finishes.
- **Independent acceptance, not self-assessment.** Code submissions become immutable Git commits. A different worker reviews each one, and the host runs the declared verification commands in a fresh checkout of the submitted commit. A failed command cannot be overridden by an agent claiming success.
- **Verification that can actually run your checks.** The clean checkout is given your project's installed dependency directories, so `npm test`, `pytest` and friends find their toolchain instead of failing with "command not found".
- **Dependency-aware scheduling.** Tasks unlock only when their prerequisites are accepted, a rejected task is repaired by a replacement that carries the original acceptance criteria, and dependents follow the repair automatically.
- **Evidence with provenance.** A finding cites the host's own tool-run ids and, for code, an artifact commit. A challenge reopens the affected result and invalidates what depended on it.
- **Visible cost.** Token usage is reported in disjoint buckets — uncached input, cache read, cache write, output (with its reasoning share) and physical request count — per worker and per mission, with the primary conversation's usage shown separately.
- **Agent-selected resource limits.** The primary chooses token and step budgets, team size, task and experiment limits, mission duration, model routes, per-worker output allowances, recovery attempts and verification timeouts, and can revise them later with a recorded reason without resetting usage.
- **Durable collaboration.** SQLite coordination state, attempt fencing, retained worktrees and recoverable peer messages survive restarts, handoffs and worker failures.
- **English and Chinese UI**, light and dark themes, following the host's setting.

This is an external Harness plugin: it needs no fork of, and no changes to, Harness core.

## Architecture

```text
┌───────────────────────────── DeepSeek Harness (host) ──────────────────────────────┐
│ agent loop · sessions & inbox · tool surface · sandbox · subprocess service        │
│ approvals · durable session log · web server & browser authentication              │
└───────────────▲───────────────────────────────▲───────────────────────▲────────────┘
                │ tools / RPC / slots            │ worker sessions        │ subprocess
┌───────────────┴───────────────────────────────┴───────────────────────┴────────────┐
│ Agent Swarm (plugin)                                                               │
│                                                                                    │
│  tools.ts ── model-facing surface, role-scoped visibility, coded refusals           │
│  runtime.ts ── missions, members, workstreams, tasks, attempts, notices, decisions  │
│  scheduling.ts ── tick loop: dispatch, stall witnesses, coverage, check envelopes   │
│  admission.ts / plans.ts ── plan validation before any worker starts                │
│  workspaces.ts ── baseline snapshot, member worktrees, verification checkouts       │
│  verification + delivery ── declared checks on the exact commit, scope check, apply  │
│  harness-workers.ts ── worker adapter: bind, prepare, start, observe, submit, close │
│  store.ts ── SQLite state, durable outbox, owner lock, snapshots and restore         │
│  web-api.ts ── host RPC: live state, watch cursor, mission controls                  │
│  client/ ── React panel: a pure projection of the durable state                      │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### Coordination is durable state, not process memory

The store is the single source of truth: missions, members, workstreams, tasks,
attempts, evidence, deliveries, passes, notices, drafts and the event log. The
scheduler is a tick loop over that state, so a restart resumes the board instead
of losing it. Exactly one live runtime may own a database; a second opener is
refused by an owner lock that names the holding pid, and a lock left by a dead
process is reclaimed.

### Attempts are fenced

Claiming a task creates an attempt with an epoch and a lease. The lease is
renewed only while the adapter observes a real, uncancelled operation — a live
model stream, tool call or provider retry — never from a heartbeat or from
persisted activity after a restart. Every mutating call carries the attempt id,
so a stale attempt cannot commit: after a reassignment, a handoff or a lease
expiry, the old worker's writes are refused with a durable reason.

### Verification is host-side

A submitted artifact is a Git commit. To accept it the host creates a fresh
worktree at exactly that commit, materialises the project's installed dependency
directories into it, runs each declared command with the task's timeout inside
the Harness sandbox, and separately validates the artifact's changed paths
against the declared scope. Any non-zero exit rejects the artifact. A command
that cannot be found is reported as an environment failure, not as a defect in
the work, so a reviewer does not retry the same artifact blindly.

### The client is a projection

The panel renders a snapshot of durable rows and events, derived on demand over
the plugin's own RPC. It holds no coordination state, starts no agent turn, and
sends no model request to draw a progress bar. Live updates are a cancellable
watch with keepalives; hiding the pane stops its requests, and reopening fetches
authoritative state. The plugin writes nothing into a session log — the host's
session vocabulary is closed, so the board is the single derivation over
`swarm.sqlite` rather than a plugin-owned event.

### Invariants

- **Accepted work is immutable.** It is replaced, never edited.
- **Peer messages never grant authority.** They cannot widen scope or budgets, change ownership or waive review.
- **Independent verification means non-author.** A review is never assigned to the author of the work it reviews.
- **No silent state.** Every non-terminal board leaves the owner a durable witness: progress, an owner-decision notice keyed by a stable fingerprint of the owner-observable board, or a stall notice naming the tasks that are stuck.
- **Every command goes through the host.** Git plumbing, shell probes and declared checks all run through the host's subprocess service, which owns the process range and its termination.

## Compatibility

The following exact Harness releases are supported:

| Harness release | Release commit | Distribution |
| --- | --- | --- |
| [0.1.5-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1) | `183f08e9c6dde7e36cd2318eaee70b0da08fb35e` | npm `latest` |
| [0.1.3-alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.2) | `82a5fd61a7cf5c293cec4bdff68f455398d685e9` | npm `alpha` at the time |
| [0.1.2-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1) | `a66e4702047846cdaa10c66c9d3df3951f5ea70d` | npm `latest` at the time |

All three are prereleases, and one adapter serves all three: the worker setup hook takes the agent from whichever host supplies it, so the plugin does not fork by host version. This plugin does not claim compatibility with the older `0.1.0-rc.5` SDK or with unreleased Harness commits. The development linker checks the release revision recorded in [compatibility.json](compatibility.json), not just a version string.

Verification runs against packaged-artifact loading, native CLI profile installation and the real `/agent-swarm` browser workflow. Provider responses are scripted while Harness, tools, persistence, Git effects, authentication and browser interaction are real, so these checks establish integration behavior — not model planning success rates. See [validation](docs/validation.md).

## Install from source

You need:

- Node.js `^22.19.0 || >=24.0.0`, Git, and a POSIX system such as macOS or Linux: declared checks and syntax probes execute through `/bin/sh`, and delivery relies on POSIX link semantics. Windows execution is unsupported.
- A checkout of one of the exact Harness releases above, with dependencies installed and its CLI and Web application built.
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

### Mount by declaration (bundle profile)

`add "link:$PWD"` is the **direct mount**: the plugin package itself is the
profile's bundle layer. The repository also ships a bundle package,
[`profile/`](profile/README.md) (`@dsh-external/dsh-agent-swarm-profile`), whose
runtime content is its patch document plus its dependency on this plugin. It is
the **declared mount**: one layer composes the platform and its Web client UI,
with portable roots, explicit defaults, and its prerequisites and conflicts named
in the package's own metadata.

```sh
node "$DSH_HARNESS_ROOT/apps/cli/lib/bin.js" plugin --profile web add "file:$PWD/profile"
```

The CLI installs the bundle and this plugin as its payload, and appends the
bundle to `dsh.profile.bundles` after the `@deepseek-ai/dsh-base` and
`@deepseek-ai/dsh-web-app` layers it declares as prerequisites. Its roots are
portable and explicit — `$DSH_AGENT_SWARM_ROOT`, else `$DSH_HOME/agent-swarm` —
and a caller points them elsewhere with that variable or with a `--patch` overlay
that addresses the `dsh-external-agent-swarm` row by id.

Mount this bundle **or** the plugin package as a layer, never both: both patch
layers insert the same row id, and the bundle declares that conflict in its
metadata.

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

**Controls.** **Pause**, **Resume**, **Complete** and **Stop** sit in one row beside the progress summary; **Stop** asks for a second click. Hiding the sidebar pauses its display, not the workers. Raising a budget does not by itself resume a paused mission and never resets consumption; mission duration is wall-clock from creation, including time spent paused.

**When something goes wrong.** The primary agent is told only when a decision is needed — a rejected review, a challenged finding, a worker failure, an approaching or exhausted budget, a board where nothing can be scheduled, or completion. It can withdraw admitted-but-mistaken work, repair blocked work with a replacement task that keeps the original acceptance criteria, or raise a ceiling with a recorded reason.

**The deliverable** for code work is an independently accepted commit and its worktree — the final integration, or the single reviewed implementation when the plan needed no assembly step. A completed mission's sidebar offers **View changes** and **Apply result**, both measured against the project snapshot so your pre-existing edits are never counted as swarm output. Applying merges into your working files while preserving your branch and index, reports conflicts before changing anything, and does not stage, commit or push.

## Resource limits and cost

Budgets are chosen by the primary agent and enforced by the runtime across the whole team.

- **Token accounting is bucketed.** Uncached input, cache read, cache write, output (including its reasoning share) and physical request count are recorded per worker and per mission. The sidebar shows the breakdown under *Task details and resources*.
- **Cached input is charged at a discount.** Cache reads count toward the budget at `cacheReadWeight` (default `0.1`) while the raw buckets stay exact, so a cache-heavy review is not throttled at roughly ten times its real cost. Displayed volume and charged cost are therefore different numbers, deliberately.
- **The primary conversation's own usage is tracked separately** and attributed to its mission, but is not charged against the worker pool.
- **Warnings arrive before exhaustion.** The primary agent is notified as each dimension crosses `budgetWarnAt` (default `0.7` and `0.9`), and an exhausted mission names which dimension ran out.
- **A step is refused when the pool is already committed.** Requests still streaming are estimated at each worker's average, so an in-flight burst is less likely to overshoot the ceiling.
- **Check execution is bounded per host.** `checkConcurrency` limits how many declared checks run at once; the rest queue in FIFO order, and the measured envelope (limit, active, queued, wait and run times) is recorded durably.

## Sidebar

The panel takes the first surface the host provides, and falls back in this order:

1. **The host's own right sidebar** (Harness 0.1.5 and later), the pane the Files tab uses. Agent Swarm registers a tab type, its body, and one capsule on that pane's Start page, so the panel opens beside the conversation instead of taking the main column; `/agent-swarm` and the conversation card reveal the tab through the host's controller. The registration is structural — the plugin imports none of the sidebar packages — so the same build still loads on 0.1.2/0.1.3, where this path never fires.
2. **Better Sidebar**, when a profile mounts it: pick **Agent Swarm** from its **+** tab menu; per-tab conversation scope and visibility are respected, and pinned tabs keep their own session.
3. **A standalone dock** beside the conversation: collapse and reopen from the Agent Swarm rail, and its width is remembered. Narrow screens move the panel below the conversation. The dock reserves its space by setting the host root's inline width, so it never names a host id and never needs `!important`.

Whatever the surface, the panel body is the same projection of the durable state.

The overview answers "what is happening" before any disclosure is opened:

- **Mission state** — the projected phase with its own provenance: the label, the note, the count it quantifies and the durable fact it was derived from (`data-swarm-owner-state`).
- **Team activity** — one card per member, with that member's name, role, status, current task, live progress bar and model. A declared step ceiling gives a determinate ratio; a held attempt shows its lease countdown; otherwise the bar is indeterminate, never an invented percentage.
- **Work board** — seven lanes (ready, queued, in progress, awaiting acceptance, blocked, cancelled, accepted) led by a one-line lane-count strip. An empty lane collapses to its header, a card's reason is one clipped line that unfolds, and a cancelled card names its cause.
- **Activity** — the retained event window grouped by durable actor, newest first, with each worker's own sprite on its group.
- **Evidence, dependency graph, budgets and usage** — behind *Task details and resources*.

**Worker identity.** Every worker carries a human given name from a fixed pool of 40 names — no vendor or product name — together with the responsibility text it was admitted with. `swarm_add_member` assigns the next unused name in assignment order when the caller supplies none; a name is unique within its mission and never reused while the mission is active, and an explicit name is still honoured. The name is a display identity only: `role` keeps the responsibility text unchanged and every delivery, assignment and tool argument addresses the **member id**, so nothing in the protocol depends on a display name. Each member is drawn as a deterministic pixel sprite derived from the name — an FNV-1a hash grows an 8×8 sprite mirrored about its vertical axis, using 3–4 colours from a fixed four-colour palette, rendered as inline SVG `<rect>`s with `shape-rendering: crispEdges`, scaled by whole or half steps so the grid stays crisp. The sprite is `aria-hidden` — a screen reader hears the name once — and it adds no image asset, no network request, no dependency and no model turn.

Activity labels come from real model requests, tool executions, verification runs and provider retries. Elapsed time counts from the operation's observed start. These describe what the host has seen — an active request is not a promise of useful progress. On a connection failure the panel shows **Reconnecting** and marks retained activity as last-observed.

An **Advanced: configure a mission** disclosure remains available for explicit manual planning with saved drafts, model choices and task graphs. Saving a draft starts no workers. The natural-language command is the normal entry point.

## Collaboration model

1. The primary agent supplies a complete plan: objective, scope, acceptance criteria, budgets, members, workstreams and a task graph. The runtime validates it before any worker starts and returns every field problem at once so one repair fixes the whole plan.
2. Workers propose further work inside the mission, exchange attributed peer messages, publish evidence tied to host-recorded tool executions, and post typed notes to the sanctioned mission board (`swarm_post`, read back with `swarm_board`). Every tool result a worker receives carries the host's own run id, so a claim can cite it.
3. Work is submitted as an immutable artifact. Independent review starts as soon as the source is submitted; ordinary dependencies unlock only after acceptance. A review is never assigned to the author of the work it reviews.
4. A challenge reopens the affected result and invalidates whatever depended on it. A handoff checkpoints partial work and stops the previous attempt before a replacement can begin.
5. Blocked work is repaired by a replacement task that carries the original acceptance criteria. Dependents follow the repair automatically — a task that depended on the rejected original becomes ready when the accepted replacement lands, and is built against the replacement's artifact.
6. A mission completes when independently accepted work covers every acceptance criterion. If the board reaches a state where nothing can ever be scheduled again, the primary agent is told once, with the specific tasks that are stuck.

Coordination policy lives in the runtime; lifecycle and sandboxing use native Harness services. See [design traceability](docs/design.md).

### Arena contracts and the no-silent-state invariant

- **No silent state.** Every non-terminal board state leaves the owner a durable witness: progress, an owner-decision notice keyed by the mission-state fingerprint `F(S)`, or a stall notice for `F(S)`. `F(S)` is a stable digest of the owner-observable board — task and member status, dispatchable readiness, unreviewable submissions, pending deliveries, open challenges and hit ceilings — with wall-clock fields excluded, so an idle tick never re-notifies and a state that changes and returns can.
- **Typed escalation.** `swarm_escalate` lets a member raise a first-class durable escalation to the owner (authenticated sender, mission, task/attempt, fingerprint). It is not a board post and grants no authority; it appears in the owner's notice ledger and arena view.
- **Bounded proposals.** A worker's board share is bounded inside the owner-set mission ceiling (`ceil(maxTasks / maxWorkers)`, floor 1). A refusal for the allowance, the task budget or the experiment budget records a durable `task/proposal-refused` event and wakes the owner with the member, the limit and the reason; only the owner raises the allowance, by raising the ceiling.
- **Read-only registry.** `swarm_registry` is the owner-only, read-only cross-mission artifact registry (commit, task, mission, acceptance state, review verdict). Per-mission artifact refs are private, so this durable projection is the sanctioned cross-mission read path.
- **Notice ledger.** Every owner notice records its class, the fingerprint it announced and its sent/queued/claimed lifecycle; the owner reads the ledger read-only through `swarm_observe`.
- **Provider-outage routing.** A classified quota, rate-limit or unavailable provider failure is a quiescent route, not a worker failure: the attempt is preserved, no recovery credit is spent, the owner is told once per class transition, and the work is routed to another live member when one exists.
- **Store snapshot and restore.** The store writes periodic `VACUUM INTO` snapshots beside the state file. A truncated or deleted store fails closed naming its snapshot, and the owner stages one validated snapshot with `swarm_restore`; the next host start applies it before the store opens.
- **Host restart.** A host-caused stop re-pends the task without spending recovery credit and records a per-task `task/restart-repended` event, so a `maxRecoveryAttempts: 1` task survives one restart.
- **Isolation.** Verification checkouts copy ignored dependency directories by default. The shared temp roots are a cross-member channel, so the runtime records a bounded `isolation/temp-rendezvous` event when two members name the same shared-temp path inside the window.

## Storage and configuration

The plugin's Loader row is `dsh-external-agent-swarm`. Settings are defined in [src/index.ts](src/index.ts):

| Setting | Default | Purpose |
| --- | --- | --- |
| `statePath` | `~/.dsh/agent-swarm/swarm.sqlite` | Coordination state. One live runtime per file. |
| `workspacesRoot` | `~/.dsh/agent-swarm/workspaces` | Snapshots, worker worktrees, verification checkouts. Must be outside your source repository. |
| `verificationDependencyDirs` | `["node_modules", ".venv", "venv", "vendor", ".tox"]` | Installed dependency directories made available to verification checkouts. |
| `verificationDependencyMode` | `"link"` | `link` is honored only with `allowDependencyLinkReads`; otherwise the effective mode is `copy` (clones them per checkout). |
| `allowDependencyLinkReads` | `false` | Human opt-in that makes a configured `verificationDependencyMode: "link"` effective. |
| `checkConcurrency` | `2` | Maximum declared-check executions per host; the rest queue in FIFO order. |
| `cacheReadWeight` | `0.1` | Budget weight for cached input. Raw buckets are unaffected. |
| `budgetWarnAt` | `[0.7, 0.9]` | Fractions at which the primary agent is warned per dimension. |
| `authorizedWorkspaces` | `[]` | Human-authorized roots (`{ path, note?, expiresAt? }`) a mission may target outside the session cwd. Loaded once at start; no tool can change it. |
| `checkTimeoutMs` | `600000` | Fallback timeout for one declared check when a task does not choose one. |
| `leaseMs` | `120000` | Attempt lease, renewed only while a real operation is observed. |
| `tickMs` | `1000` | Scheduler tick. |

Only one live runtime may own a database. To run independent Harness processes, give each an absolute `statePath` and `workspacesRoot` through its profile overlay. **Changing `DSH_HOME` alone does not isolate this plugin's storage.** The [bundle profile](profile/README.md) states both roots explicitly and portably — `DSH_AGENT_SWARM_ROOT`, else `$DSH_HOME/agent-swarm` — and a caller points them elsewhere with that variable or a `--patch` overlay.

Infrastructure settings never replace the primary agent's decisions: an automatic plan must still supply its own complete resource budgets and task policies.

### Authorized workspaces (human-only surface)

A mission workspace is accepted only when it equals the calling session's working directory or resolves (realpath, symlink-resolved) inside one of the roots in `authorizedWorkspaces`. The roots are read once from plugin configuration at start; **no model-callable tool can create, widen or revoke a root**, and changing the set requires a human editing the profile or `cordis.patch.yml` and restarting the host. `swarm_create` and `swarm_stage` overwrite the model-supplied workspace with the resolved path and record the matched root durably as `mission.workspaceGrantRoot` plus a `mission/workspace-bound` audit event; `workspace/grant-loaded` records each configured root at start. An unauthorized path is refused with a field-level `[workspace_not_authorized]` diagnostic naming the requirement and how a human grants it. Removing a root and restarting refuses new missions and fences a running one (durable blocked reason plus an owner notice) at its next workspace preparation or verification checkout. Worker sessions never create missions or use a grant. See [known limitations](docs/known-limitations.md) for the residual risks — model write access to the configuration file, TOCTOU on a replaced root, and the fact that authorization is not confidentiality.

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
| `npm run test:bundle` | The declarative bundle profile: metadata, portable roots, host composition, and a real `dsh --profile web` boot. |
| `npm run test:web` / `test:command-web` | The sidebar and `/agent-swarm` browser workflows. |

Suites use temporary profiles and Git workspaces, with the model boundary scripted. `test:deepseek` and `test:command-deepseek` make real provider requests, can incur charges, and are excluded from `verify`. Completed runs and their measured numbers are recorded in [validation](docs/validation.md).

## Current limitations

- **Local, single-host.** Git workspaces and the host's subprocess service (`ctx.subprocess`) are required: every command, including each declared check, runs as a provider-managed process range. Distributed workers and non-Git workspaces are not implemented.
- **Verification proves that your commands ran, not that they are sufficient.** The host executes exactly what a task declares, against the exact submitted commit. It cannot infer a complete test oracle from a natural-language goal.
- **The verification checkout borrows your installed toolchain.** Dependency directories are copied into the disposable checkout by default, so `..` cannot resolve into your source checkout; a read-through `link` requires the explicit `allowDependencyLinkReads` opt-in. Either way they are not a fresh install and may differ from CI.
- **Budget accounting is provider-reported.** In-flight requests are estimated, so an unusually large one can still cross a ceiling. Attempts that report no usage cannot be counted.
- **Confinement follows the configured Harness sandbox.** Artifact capture checks changed paths against declared scopes. The plugin adds no independent network or credential isolation, and its tool restrictions are not a complete boundary for every side-effecting tool.
- **Recovery is bounded.** Attempt leases renew only while a live operation is observed, within the mission deadline; this does not detect every stuck request. Retained worktrees and Git refs require explicit cleanup.
- **Views are deliberately limited.** Live updates reconcile committed state rather than streaming tokens. Cold worker history is a text and tool-record projection, with media shown by type and long entries truncated.
- **Compatibility is bounded by the tested compositions.** Better Sidebar integration was exercised against version 0.18.0; that does not establish compatibility with every other plugin or custom profile.

See [known limitations](docs/known-limitations.md) for the detailed list.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Design traceability is recorded in [docs/design.md](docs/design.md); the tested matrix and its limits in [docs/validation.md](docs/validation.md).
