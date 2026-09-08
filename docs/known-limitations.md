# Known limitations

This is an experimental, single-host plugin. The current compatibility tests do not establish that all collaboration, isolation or acceptance problems are solved.

## Execution and resources

- The default attempt lease is 120 seconds. The runtime renews it only while the adapter identifies an owned, uncancelled native model/tool/verification operation or provider retry, and renewal is bounded by the mission deadline. This identifies operation liveness, not useful progress. A stuck operation still relies on its provider/tool timeout, cancellation or mission deadline. Persisted activity alone never authorizes renewal after restart.
- The primary agent chooses and can revise resource budgets. Token accounting uses provider-reported worker usage, so in-flight requests can exceed a threshold before usage arrives. The owner's own model usage is outside the worker pool.
- Mission duration is elapsed wall-clock time from creation. Pausing does not freeze the clock; the primary can revise the duration explicitly.
- POSIX process groups are required. Windows execution is not supported.

## Tool authority and verification

- The worker guard is a name-based deny list, not a complete capability allowlist. Other profile tools, including scheduling tools such as `cron_add`, may have external effects that the list does not cover. No separate network/credential policy or adversarial multi-tenant isolation is provided.
- Declared scopes are checked when artifacts are captured; they are not per-shell-write allowlists.
- Independent host verification proves that the declared checks ran against the exact artifact. It does not prove those checks are meaningful. Initial automatic checks come from the primary, but participant proposals remain possible and there is no mandatory mission-wide acceptance baseline imposed on every artifact.
- Automatic planning uses the owner's ordinary Harness agent and tools. The prompt supplies a frozen planning directory, while the owner's native cwd remains its source project; following the read-only snapshot path is not a separate OS enforcement boundary. Worker baselines are enforced by the runtime. Advanced `swarm_create`/staging tools also have broader workspace inputs than the native command's session-bound workflow.

## Storage and recovery

- Default plugin state paths use `~/.dsh/agent-swarm`, independently of `DSH_HOME`. Separate hosts must configure distinct `statePath` and `workspacesRoot`; sharing one database is rejected by an exclusive owner lock.
- Live update cursors upgrade the database from schema 1 to schema 2. Older plugin builds reject schema 2, so downgrade requires a consistent pre-upgrade database backup or separate state path. Keep the matching workspaces, recovery journals and Git refs.
- Automatic startup snapshots tracked files and non-ignored untracked files without moving the branch or changing the real index. Ignored untracked files, including dependencies or local environment files, are not included. Unsupported states such as unresolved conflicts or dirty submodules must be resolved first. The capture checks for concurrent edits and retries; it is not a filesystem-wide atomic snapshot.
- Worker worktrees, planning snapshots and artifact refs are retained after stop/completion. Startup preserves source working files, index and branch; **Apply result** explicitly updates only working files. Result comparison uses the saved snapshot, and conflicts are returned without source changes. Shared Git objects, refs and metadata remain under `.git`; cleanup remains explicit.
- Stable IDs and a durable inbox recovery journal cover tested stop/restart paths. They do not guarantee exactly-once external tool side effects or recovery from arbitrary disk faults.
- Applying a result is not a filesystem-wide atomic transaction. Concurrent edits trigger rollback; if later edits prevent restoration, the error identifies retained recovery copies. A hard process or disk failure during the write phase may require recovering those copies manually. Submodule changes and directory/file conversions are not automatically applied. Snapshot storage must be outside the source repository.
- Outbox retries lack complete failure counters, backoff and delivery diagnostics. Offline-owner notifications can remain pending. Process-lock detection does not distinguish PID reuse, and a full WAL/umask permission matrix has not been validated.

## Interface and model behavior

- The live sidebar observes committed changes through native RPC long polling, with bounded change history and keepalives. Updates carry changed mission snapshots rather than individual text tokens. There is no fixed two-second refresh delay, but a busy host, browser or network can still delay delivery; this is not a hard real-time guarantee. A disconnected panel marks its retained activity as stale; reconnecting or reopening fetches authoritative state, with full-snapshot fallback when its cursor cannot be replayed. Conversation cards remain historical snapshots; an explicit observation creates a new snapshot.
- Cold worker history is a read-only text/tool projection, not the complete native chat UI. Media is represented by type, and long entries are explicitly truncated. A live worker's native chat composer may remain writable; mission-management permissions are checked separately.
- Swarm tools and their usage prompt are currently registered across the profile, so they add context even outside a swarm task. Observation output is compact by default but is not bounded by one fixed byte limit regardless of mission size.
- Correct plan generation and useful acceptance criteria still depend on the model and task description. The primary can repair validation errors, but deterministic test fixtures do not establish a general real-model success rate.
