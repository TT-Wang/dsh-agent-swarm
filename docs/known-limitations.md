# Known limitations

This is an experimental, single-host plugin. The current compatibility tests do not establish that all collaboration, isolation or acceptance problems are solved.

## Execution and resources

- The default attempt lease is 120 seconds. Ordinary long-running tools are renewed mainly at step/tool boundaries and can outlast their lease. Host verification has additional timeout-aware protection; it is not a general heartbeat for every tool.
- The primary agent chooses and can revise resource budgets. Token accounting uses provider-reported worker usage, so in-flight requests can exceed a threshold before usage arrives. The owner's own model usage is outside the worker pool.
- Mission duration is elapsed wall-clock time from creation. Pausing does not freeze the clock; the primary can revise the duration explicitly.
- POSIX process groups are required. Windows execution is not supported.

## Tool authority and verification

- The worker guard is a name-based deny list, not a complete capability allowlist. Other profile tools, including scheduling tools such as `cron_add`, may have external effects that the list does not cover. No separate network/credential policy or adversarial multi-tenant isolation is provided.
- Declared scopes are checked when artifacts are captured; they are not per-shell-write allowlists.
- Independent host verification proves that the declared checks ran against the exact artifact. It does not prove those checks are meaningful. Initial automatic checks come from the primary, but participant proposals remain possible and there is no mandatory mission-wide acceptance baseline imposed on every artifact.
- Automatic planning uses the owner's ordinary Harness agent and tools. A prompt asking for read-only planning is not a separate OS write barrier. Advanced `swarm_create`/staging tools also have broader workspace inputs than the native command's session-bound workflow.

## Storage and recovery

- Default plugin state paths use `~/.dsh/agent-swarm`, independently of `DSH_HOME`. Separate hosts must configure distinct `statePath` and `workspacesRoot`; sharing one database is rejected by an exclusive owner lock.
- The initial Git workspace must be clean, including untracked files. The plugin does not automatically commit or discard user changes.
- Worker worktrees and artifact refs are retained after stop/completion. Source working files and the current branch remain unchanged, but shared Git objects, refs and worktree metadata are written under `.git`. Cleanup and merging are explicit operations.
- Stable IDs and a durable inbox recovery journal cover tested stop/restart paths. They do not guarantee exactly-once external tool side effects or recovery from arbitrary disk faults.
- Outbox retries lack complete failure counters, backoff and delivery diagnostics. Offline-owner notifications can remain pending. Process-lock detection does not distinguish PID reuse, and a full WAL/umask permission matrix has not been validated.

## Interface and model behavior

- The live sidebar polls local RPC state. Conversation cards remain historical snapshots; an explicit observation creates a new snapshot.
- Cold worker history is a read-only text/tool projection, not the complete native chat UI. Media is represented by type, and long entries are explicitly truncated. A live worker's native chat composer may remain writable; mission-management permissions are checked separately.
- Swarm tools and their usage prompt are currently registered across the profile, so they add context even outside a swarm task. Observation output is compact by default but is not bounded by one fixed byte limit regardless of mission size.
- Correct plan generation and useful acceptance criteria still depend on the model and task description. The primary can repair validation errors, but deterministic test fixtures do not establish a general real-model success rate.
