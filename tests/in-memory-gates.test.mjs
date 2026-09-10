/**
 * S5 (a): the in-memory gate inventory.
 *
 * The Row-13 incident: the only active mission produced ZERO durable events for
 * 120 minutes after `task/lease-expired` while the same host kept serving
 * another mission, because the in-memory `scheduled` Set in `Runtime.kick()`
 * swallowed the tick timer's only liveness action. Round 13's T1 converted that
 * guard to the durable per-mission `passes` row and deleted the Set; this file
 * includes that work as the `scheduled` absence claim below and does not
 * duplicate it.
 *
 * What this file is: an EXHAUSTIVE census of every `new Map`/`new Set`/
 * `new WeakMap`/`new WeakSet` occurrence in `src/` (excluding `src/client`, the
 * browser bundle), each classified, plus one behaviour test per gate entry.
 * Absence claims here are backed by the census, never by example: the first
 * test fails if any occurrence in the tree is unclassified, so "there is no
 * other in-memory gate" is a machine check, not a reading.
 *
 * The unit that carries a LABEL is the runtime's own decision path:
 * `SwarmRuntime`, its seven extracted seams (`attempts`, `gates`, `notices`,
 * `refusals`, `declared-checks`, `workspace-admission`, `scheduling`) and the
 * `SwarmStore` it owns. Occurrences outside that unit (the workspace engine, the
 * harness worker adapter, the trace read model, the web projection, the delivery
 * engine) are enumerated with an explicit `outside` classification and reason —
 * enumerated, but no label claimed for them and no runtime test written, because
 * the runtime reaches them only through an injected adapter.
 *
 * The two labels, defined operationally:
 *  - `derivable`: the gate consults durable state before it acts, so clearing
 *    the collection cannot make the gate wrong. The test re-reads the store.
 *  - `cache-only`: clearing the collection cannot change a durable outcome or
 *    produce a wrong durable transition; the worst case is duplicated idempotent
 *    work or a lost in-process notification. The test clears it and shows the
 *    durable result is unchanged.
 *
 * A third label is possible and this file refuses to hide it: `unsafe-in-memory`
 * means the collection is neither. Clearing (or, worse, keeping) it provably
 * changes externally visible behaviour, and its fix needs a file outside S5's
 * declared scope, so the entry carries a hand-off note in the submission naming
 * the exact change. The census test asserts the count of unsafe entries so it
 * cannot grow silently. Today there are exactly three, all in `src/runtime.ts`:
 * `queues` (presence swallows the mission's next liveness action — the same P0
 * class as the deleted `scheduled` Set), `startControllers` and `startFailures`.
 *
 * Co-firing guards (every guard must name what it can fire with):
 *  - the per-task revision CAS in `SwarmStore.putTask` fires with the mission
 *    queue (`queues`), the fingerprint cache and the writer-busy retry; the pair
 *    tests live in `tests/task-revision.test.mjs`;
 *  - the fingerprint cache fires with `commitDepth` (bypassed inside a
 *    transaction) — pinned below;
 *  - the notice-dedup sets fire with the durable delivery ledger — pinned below.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import { setup, eventually, events, taskOf } from './faults/harness.mjs'

const PROJECT = fileURLToPath(new URL('../', import.meta.url))

/**
 * Exhaustive census, keyed by [file, occurrence index within the file, constructor, source, class, label, reason].
 * The occurrence index (not the line number) is the key, so an unrelated edit
 * above an entry does not invalidate it; the source text is checked too, so a
 * rewritten entry is reported instead of silently re-classified.
 */
const CENSUS = [
  ["src/admission.ts", 1, "Set", "const WRITE_VERBS = new Set([", "constant", "", "module-level immutable lookup table, never mutated after construction: data, not a gate"],
  ["src/admission.ts", 2, "Set", "const seen = new Set<string>()", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/admission.ts", 3, "Set", "const seen = new Set<string>()", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/admission.ts", 4, "Set", "const seen = new Set<string>()", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/admission.ts", 5, "Set", "const candidates = [...new Set(paths.map(path => path.replace(/^\\.\\//, '')).filter(path => path && !path.endsWith('/') && !isAbsolute(path) && !path.includes('*') && !path.split('/').some(part => part === '..')))]", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/admission.ts", 6, "Set", "const hidden = new Set(String(ignored.stdout).split('\\0').filter(Boolean))", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/admission.ts", 7, "Set", "const resolved = resolveHostOnlyScript(command, scripts, new Set(), 0)", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/admission.ts", 8, "Set", "const SHELL_WORD_OPERATORS = new Set([';', '&', '|', '(', ')', '<', '>', '\\n'])", "constant", "", "module-level immutable lookup table, never mutated after construction: data, not a gate"],
  ["src/admission.ts", 9, "Set", "const seen = new Set<string>()", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/arena.ts", 1, "Set", "export function liveCarrier(tasks: readonly Task[], dependencyId: string, seen: Set<string> = new Set()): Task | undefined {", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/attempts.ts", 1, "Map", "readonly idleSignals = new Map<string, { attemptId: string; at: number }>()", "gate", "cache-only", "the durable Task.idleSignal carries the same value and the scheduling pass re-reads it"],
  ["src/attempts.ts", 2, "Set", "if (owner !== undefined) task.priorOwnerIds = [...new Set([...(task.priorOwnerIds ?? []), owner])]", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/delivery.ts", 1, "Set", "const activeSources = new Set<string>()", "outside", "", "outside the runtime decision path: the delivery engine module (applyDelivery); the runtime serializes applies per workspace through exclusive(\"delivery:<workspace>\"), so the runtime path does not depend on this process-global mutex (enumerated, no label claimed)"],
  ["src/delivery.ts", 2, "Map", "const sourceIdentities = new Map<string, string>()", "outside", "", "outside the runtime decision path: the delivery engine module (applyDelivery); the runtime serializes applies per workspace through exclusive(\"delivery:<workspace>\"), so the runtime path does not depend on this process-global mutex (enumerated, no label claimed)"],
  ["src/gates.ts", 1, "Map", "readonly fingerprintCache = new Map<string, { revision: number; fingerprint: string }>()", "gate", "cache-only", "keyed by the global store revision; the digest is pure over durable state and is bypassed inside a transaction"],
  ["src/gates.ts", 2, "Set", "readonly budgetStops = new Set<string>()", "gate", "cache-only", "S5r: the durable `budgetPause.stopping` claim (written before the first await, bounded like the pass guard) is the gate; the Set is only the public mirror `SwarmRuntime.budgetStops` names and is never read to decide whether a stop may run"],
  ["src/gates.ts", 3, "Set", "const ready = new Set(tasks.filter(task => task.status === 'pending' && runnable.some(member => this.rt.ready(task, member, tasks))).map(task => task.id))", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/gates.ts", 4, "Set", "const unreviewed = new Set(tasks.filter(task => task.status === 'submitted' && !this.rt.reviewable(task, tasks)).map(task => task.id))", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/git-snapshot.ts", 1, "Set", "const trackedSet = new Set(tracked)", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/git-snapshot.ts", 2, "Set", "const headPaths = new Set(headEntries.map(entry => entry.slice(entry.indexOf('\\t') + 1)))", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/git-snapshot.ts", 3, "Map", "const submodules = new Map(headEntries.filter(entry => entry.startsWith('160000 ')).map(entry => {", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/git-snapshot.ts", 4, "Set", "for (const filename of [...new Set([...headPaths, ...tracked, ...untracked])].sort()) {", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/harness-workers.ts", 1, "Map", "private readonly residents = new Map<string, Resident>()", "outside", "", "outside the runtime decision path: the harness worker adapter (HarnessWorkers): resident handle, observation, delivered-message and recovery-inbox state for live host agents; the runtime reaches it only through the injected WorkerAdapter (enumerated, no label claimed)"],
  ["src/harness-workers.ts", 2, "Set", "const consumed = new Set(agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data.id))", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/harness-workers.ts", 3, "Set", "const pending = new Set([...agent.inbox.nextStep, ...agent.inbox.nextTurn].map(message => message.id))", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/harness-workers.ts", 4, "Set", "const resident: Resident = { spec, abort: new AbortController(), opening: Promise.resolve(), observations: new Set(), delivered: new Set(), recoveryInbox: new Map(), journalWrites: Promise.resolve(), totalTokens: 0, usage: emptyBuckets(), lastPromptTokens: 0, compactionRequested: false, recordedExecutions: new WeakSet(), rejectedPendingStep: false, activities: new Map() }", "outside", "", "outside the runtime decision path: the harness worker adapter (HarnessWorkers): resident handle, observation, delivered-message and recovery-inbox state for live host agents; the runtime reaches it only through the injected WorkerAdapter (enumerated, no label claimed)"],
  ["src/harness-workers.ts", 5, "Set", "const visible = new Set(agentCtx.tools.schemas(agent).map(schema => schema.name))", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/harness-workers.ts", 6, "Set", "const claimedIds = new Set(messages.map(message => message.id))", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/notices.ts", 1, "Set", "readonly parkedNotices = new Set<string>()", "gate", "derivable", "the durable delivery ledger (class, dedupKey, sender) is the gate; the set only avoids the read"],
  ["src/notices.ts", 2, "Set", "readonly integrationGapWarned = new Set<string>()", "gate", "derivable", "the durable delivery ledger is the gate; the set only avoids the read"],
  ["src/notices.ts", 3, "Set", "readonly reviewPathNotices = new Set<string>()", "gate", "derivable", "the durable delivery ledger is the gate; the set only avoids the read"],
  ["src/notices.ts", 4, "Map", "private readonly delivering = new Map<string, number>()", "gate", "cache-only", "per-attempt claim; the durable deliveredAt row is the real gate and adapter acceptance is idempotent"],
  ["src/plans.ts", 1, "Map", "const result = new Map<string, Record<string, unknown>>()", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/plans.ts", 2, "Set", "const names = new Set<string>()", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/plans.ts", 3, "Map", "const byKey = new Map(tasks.map(task => [task.key, task])), visiting = new Set<string>(), done = new Set<string>(), result: PlanTask[] = []", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/roles.ts", 1, "Map", "private readonly applied = new Map<string, Applied>()", "outside", "", "outside the runtime decision path: the plugin composition tool-registration cache, not the runtime mission path (enumerated, no label claimed)"],
  ["src/roles.ts", 2, "Set", "const visible = new Set(agent.ctx.tools.schemas(agent).map(schema => schema.name))", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts", 1, "Set", "private readonly listeners = new Set<(missionId: string) => void>()", "gate", "cache-only", "in-process change fan-out; a lost notification changes no durable state and a subscriber re-reads on its next request"],
  ["src/runtime.ts", 2, "Map", "readonly queues = new Map<string, Promise<unknown>>()", "gate", "unsafe-in-memory", "presence swallows: every mission operation chains on the previous promise, and the pass watchdog deletes that chain entry only for a wedged pass while the mission has NO live work (checkSchedulingPasses), so a hung non-pass operation (submit, verify, captureArtifact) keeps swallowing later mission operations while any attempt holds a live lease; hand-off: give exclusive its own declared bound instead of relying on the pass watchdog"],
  ["src/runtime.ts", 3, "Set", "private readonly operations = new Set<Promise<unknown>>()", "gate", "unsafe-in-memory", "S5r: the registry is what `dispose()` drains (up to stallPassTimeoutMs) before it closes the store, and `defer` executes the body AFTER the caller returns; clearing it while a deferred write is in flight lets dispose() close the store first and the write is lost (probe below). hand-off: make the store own its in-flight writes (or have defer register with the store) so dispose drains the store, not a runtime registry"],
  ["src/runtime.ts", 4, "Map", "private readonly startControllers = new Map<string, AbortController>()", "gate", "unsafe-in-memory", "loss removes the only cancellation channel of an in-flight launch; hand-off: re-check the durable start row status before activation instead of trusting the handle"],
  ["src/runtime.ts", 5, "Map", "readonly startFailures = new Map<string, number>()", "gate", "unsafe-in-memory", "memory-only consecutive-failure counter gates member retirement; loss resets it and the member is retried instead of retired; hand-off: persist it on the member row or derive it from the durable task/start-failed events"],
  ["src/runtime.ts", 6, "Map", "private readonly observeCursors = new Map<string, DeliveredCursor>()", "gate", "cache-only", "delivered-position context cache; loss re-sends one bounded focused view and a cursor can never exceed the durable log"],
  ["src/runtime.ts", 7, "Map", "private readonly autoReviewAdmissions = new Map<string, string>()", "gate", "derivable", "the durable task/review-admitted event is read first; the map is only a fallback for an admission whose event write failed"],
  ["src/runtime.ts", 8, "Set", "private readonly reviewPathReported = new Set<string>()", "gate", "derivable", "the durable task/review-missing event for the exact submission is re-read before the set is trusted"],
  ["src/runtime.ts", 9, "Set", "const seen = new Set<string>()", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts", 10, "Set", "const seen = new Set<string>()", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts", 11, "Set", "dependencyIdentities(missionId: string, dependencyId: string, tasks?: Task[]): Set<string> { return new Set(this.lineage(missionId, dependencyId, tasks).map(task => task.id)) }", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts", 12, "Set", "const seen = new Set<string>([task.id])", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts", 13, "Map", "const byId = new Map(tasks.map(task => [task.id, task]))", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts", 14, "Map", "const chains = new Map<string, string[]>()", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts", 15, "Set", "const candidate = visit(task.id, new Set())", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts", 16, "Set", "const member: Member = { id: memberId, missionId, name: input.name, role: input.role, model: input.model, provider: input.provider, reasoningEffort: input.reasoningEffort, maxOutputTokens: input.maxOutputTokens, sessionId: id('swarm-session'), workspace, status: 'idle', subscriptions: input.subscriptions === undefined ? [] : [...new Set(input.subscriptions)] }", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts", 17, "Set", "const dependencies = [...new Set(normalizeReviewDependencies(input.kind, input.reviewOf, input.dependencies))]", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts", 18, "Set", "if (input.replaces?.length) task.replaces = [...new Set(input.replaces)]", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts", 19, "Set", "const ids = new Set(task.priorOwnerIds ?? [])", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts", 20, "Set", "const released = new Set<string>()", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts", 21, "Set", "if (this.workers.compactAtBoundary) for (const memberId of new Set([source.attempt?.ownerId, member.id])) if (memberId) this.workers.compactAtBoundary(memberId)", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts", 22, "Set", "const interrupted = new Set<string>()", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts", 23, "Set", "const invalidated = new Set([source.id])", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts", 24, "Set", "const released = new Set<string>()", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts", 25, "Set", "const live = new Set(this.store.list('members', missionId).filter(member => member.status !== 'stopped').map(member => member.id))", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts", 26, "Set", "const released = new Set<string>()", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts", 27, "Set", "member.subscriptions = [...new Set(topics)]", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts", 28, "Map", "const byKey = new Map(plan.tasks.map(task => [task.key, task]))", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts", 29, "Set", "const pending = [...(byKey.get(key)?.dependencies ?? [])], visited = new Set<string>()", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts", 30, "Set", "const memberMissions = new Set(this.store.list('members').filter(m => m.sessionId === actor.sessionId && m.status !== 'stopped').map(m => m.missionId))", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts", 31, "Set", "const leftover = options.cancelUnschedulable ? new Set(this.unschedulable(mission, tasks, this.store.list('members', mission.id)).map(task => task.id)) : new Set<string>()", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts", 32, "Set", "const dead = new Set(tasks.filter(task => task.status === 'cancelled' || leftover.has(task.id)).map(task => task.id))", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/scheduling.ts", 1, "Set", "readonly releasedPasses = new Set<string>()", "gate", "unsafe-in-memory", "S5r: `passReleased` (src/scheduling.ts) reads only this Set, so clearing it lets an abandoned pass body resume and dispatch (probe below, deterministic). hand-off: record the released runId durably on the passes row (`SchedulingPass.releasedRunId`/`releasedAt`, types.ts) and have passReleased read that row"],
  ["src/scheduling.ts", 2, "Set", "const dead = new Set(tasks.filter(task => task.status === 'blocked' && !this.quiescencePending(task)).map(task => task.id))", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/scheduling.ts", 3, "Set", "const covers = (task: Task, sourceId: string, seen = new Set<string>()): boolean => {", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/store.ts", 1, "Set", "private readonly listeners = new Set<() => void>()", "gate", "cache-only", "observer fan-out for committed changes; the durable revision and change cursor carry the state"],
  ["src/store.ts", 2, "Set", "this.transactionScopes = new Set()", "transient", "", "created and destroyed inside one store transaction; the revision-bump decision it feeds is re-derived on every call"],
  ["src/trace.ts", 1, "Map", "private readonly indexes = new Map<string, SpanIndex>()", "outside", "", "outside the runtime decision path: the trace read model (TraceIndex): an owner-UI projection cache no runtime decision reads (enumerated, no label claimed)"],
  ["src/trace.ts", 2, "Map", "private readonly unscoped = new Map<string, number>()", "outside", "", "outside the runtime decision path: the trace read model (TraceIndex): an owner-UI projection cache no runtime decision reads (enumerated, no label claimed)"],
  ["src/trace.ts", 3, "Map", "const index: SpanIndex = { byTask: new Map(), byAttempt: new Map(), all: [] }", "outside", "", "outside the runtime decision path: the trace read model (TraceIndex): an owner-UI projection cache no runtime decision reads (enumerated, no label claimed)"],
  ["src/trace.ts", 4, "Set", "const known = new Set(spans.map(span => span?.spanId))", "outside", "", "outside the runtime decision path: the trace read model (TraceIndex): an owner-UI projection cache no runtime decision reads (enumerated, no label claimed)"],
  ["src/trace.ts", 5, "Map", "const counts = new Map<string, number>()", "outside", "", "outside the runtime decision path: the trace read model (TraceIndex): an owner-UI projection cache no runtime decision reads (enumerated, no label claimed)"],
  ["src/trace.ts", 6, "Map", "const tasks = new Map<string, string>(), members = new Map<string, string>()", "outside", "", "outside the runtime decision path: the trace read model (TraceIndex): an owner-UI projection cache no runtime decision reads (enumerated, no label claimed)"],
  ["src/trace.ts", 7, "Set", "const ATTEMPT_CLOSERS = new Set(['task/submitted', 'task/blocked', 'task/cancelled', 'task/cancelled-at-completion', 'task/lease-expired', 'task/handoff-started', 'task/invalidated', 'task/review-retired', 'task/closeout-abandoned', 'task/closeout-failed', 'task/accepted', 'task/rejected'])", "constant", "", "module-level immutable lookup table, never mutated after construction: data, not a gate"],
  ["src/trace.ts", 8, "Map", "const open = new Map<string, { taskId: string; memberId: string }>()", "outside", "", "outside the runtime decision path: the trace read model (TraceIndex): an owner-UI projection cache no runtime decision reads (enumerated, no label claimed)"],
  ["src/web-api.ts", 1, "Set", "const providers = new Set(ctx.llm.listProviders().map(provider => provider.id))", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/web-api.ts", 2, "Set", "const visibleScopes = () => new Set([sessionId, ...runtime.visibleMissions(actor).map(mission => mission.id)])", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/web-api.ts", 3, "Set", "const changed = new Set(changes.flatMap(change => change.scopes).filter(scope => allowed.has(scope)))", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/workspace-admission.ts", 1, "Set", "const SHARED_TEMP_ROOTS: readonly string[] = [...new Set(['/tmp', '/var/tmp', tmpdir()].flatMap(root => {", "constant", "", "module-level immutable lookup table, never mutated after construction: data, not a gate"],
  ["src/workspace-admission.ts", 2, "Map", "const SHELL_COMMAND_KEYS = new Map<string, readonly string[]>([", "constant", "", "module-level immutable lookup table, never mutated after construction: data, not a gate"],
  ["src/workspace-admission.ts", 3, "Set", "const GIT_OPTION_ARGUMENTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--exec-path', '--namespace', '--config-env'])", "constant", "", "module-level immutable lookup table, never mutated after construction: data, not a gate"],
  ["src/workspace-admission.ts", 4, "Set", "const COMMAND_WRAPPERS = new Set(['env', 'command', 'sudo', 'nohup', 'time', 'exec', 'nice', 'doas', 'builtin'])", "constant", "", "module-level immutable lookup table, never mutated after construction: data, not a gate"],
  ["src/workspace-admission.ts", 5, "Set", "const WRAPPER_OPTION_ARGUMENTS = new Set(['-u', '-g', '-p', '-C', '-h', '-U', '-r', '-t', '-D', '-n', '-f', '-o', '-a', '--user', '--group', '--prompt', '--host', '--other-user', '--role', '--type', '--close-from', '--chdir', '--unset', '--format', '--output', '--adjustment'])", "constant", "", "module-level immutable lookup table, never mutated after construction: data, not a gate"],
  ["src/workspace-admission.ts", 6, "Map", "private readonly tempMentions = new Map<string, TempMention[]>()", "gate", "cache-only", "bounded advisory mention window; loss re-arms the warning and decides no durable outcome"],
  ["src/workspace-admission.ts", 7, "Map", "private readonly tempRendezvousReported = new Map<string, number>()", "gate", "cache-only", "advisory rendezvous dedup window; loss re-reports the advisory warning and no durable outcome changes"],
  ["src/workspace-admission.ts", 8, "Map", "const byWorkspace = new Map<string, Member[]>()", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/workspace-admission.ts", 9, "Map", "const byTaskWorkspace = new Map<string, Task[]>()", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/workspaces.ts", 1, "Map", "const worktreeQueues = new Map<string, Promise<void>>()", "outside", "", "outside the runtime decision path: the workspace engine (Workspaces); note that worktreeQueues is a process-global promise chain with the same presence-swallows shape as SwarmRuntime.queues (hand-off) (enumerated, no label claimed)"],
  ["src/workspaces.ts", 2, "Map", "private readonly controllers = new Map<string, Set<AbortController>>()", "outside", "", "outside the runtime decision path: the workspace engine (Workspaces); note that worktreeQueues is a process-global promise chain with the same presence-swallows shape as SwarmRuntime.queues (hand-off) (enumerated, no label claimed)"],
  ["src/workspaces.ts", 3, "Set", "private readonly inFlight = new Set<Promise<unknown>>()", "outside", "", "outside the runtime decision path: the workspace engine (Workspaces); note that worktreeQueues is a process-global promise chain with the same presence-swallows shape as SwarmRuntime.queues (hand-off) (enumerated, no label claimed)"],
  ["src/workspaces.ts", 4, "Map", "private readonly baselines = new Map<string, Promise<WorkspaceBaseline>>()", "outside", "", "outside the runtime decision path: the workspace engine (Workspaces); note that worktreeQueues is a process-global promise chain with the same presence-swallows shape as SwarmRuntime.queues (hand-off) (enumerated, no label claimed)"],
  ["src/workspaces.ts", 5, "Map", "private readonly commonDirs = new Map<string, Promise<string>>()", "outside", "", "outside the runtime decision path: the workspace engine (Workspaces); note that worktreeQueues is a process-global promise chain with the same presence-swallows shape as SwarmRuntime.queues (hand-off) (enumerated, no label claimed)"],
  ["src/workspaces.ts", 6, "Map", "private readonly artifactRepos = new Map<string, Promise<string>>()", "outside", "", "outside the runtime decision path: the workspace engine (Workspaces); note that worktreeQueues is a process-global promise chain with the same presence-swallows shape as SwarmRuntime.queues (hand-off) (enumerated, no label claimed)"],
  ["src/workspaces.ts", 7, "Set", "const active = this.controllers.get(memberId) ?? new Set<AbortController>()", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/workspaces.ts", 8, "Set", "return new Set(this.options.verificationDependencyDirs ?? DEFAULT_VERIFICATION_DEPENDENCY_DIRS)", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/workspaces.ts", 9, "Set", "const candidates = new Set<string>()", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/workspaces.ts", 10, "Set", "const links = new Set<string>()", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/workspaces.ts", 11, "Set", "const changed = new Set((await this.git(member.workspace, ['diff', '--name-only', '--no-renames', '-z', baseCommit, '--'], signal, undefined, INVENTORY_BYTES)).split('\\0').filter(Boolean).filter(name => !dependencyContent(name)))", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/workspaces.ts", 12, "Set", "const names = new Set(this.options.verificationDependencyDirs ?? DEFAULT_VERIFICATION_DEPENDENCY_DIRS)", "local", "", "function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
]

/** Every `new Map|Set|WeakMap|WeakSet` occurrence in src/, in file order. */
function occurrences(root) {
  const files = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (entry.name !== 'client') walk(join(directory, entry.name)) }
      else if (entry.name.endsWith('.ts')) files.push(join(directory, entry.name))
    }
  }
  walk(root)
  files.sort()
  const found = []
  for (const file of files) {
    const name = relative(PROJECT, file)
    let index = 0
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (/(new\s+(Map|Set|WeakMap|WeakSet)\s*[<(])/.test(line)) {
        index += 1
        found.push([name, index, (line.match(/new\s+(Map|Set|WeakMap|WeakSet)\s*[<(]/) || [])[1], line.trim().replace(/\s+/g, ' ')])
      }
    }
  }
  return found
}

const GATES = CENSUS.filter(entry => entry[4] === 'gate')
const key = entry => `${entry[0]}:${entry[1]}`

test('S5 census: every in-memory collection in src/ is classified, and none is unclassified', () => {
  const found = occurrences(join(PROJECT, 'src'))
  const declared = new Map(CENSUS.map(entry => [key(entry), entry]))
  const seen = new Set()
  for (const [file, index, kind, source] of found) {
    const id = `${file}:${index}`
    const entry = declared.get(id)
    assert.ok(entry, `UNCLASSIFIED in-memory collection at ${id} (${kind}): ${source}\n` +
      'Classify it in CENSUS: a gate needs a label (derivable | cache-only | unsafe-in-memory) and a test body in GATE_TESTS; a transient, constant or out-of-unit collection needs that class and a reason.')
    assert.equal(entry[2], kind, `${id} changed constructor from ${entry[2]} to ${kind}; re-classify it`)
    assert.equal(entry[3], source, `${id} changed text; if it is still the same collection, update CENSUS, otherwise classify the new one`)
    seen.add(id)
  }
  for (const entry of CENSUS) assert.ok(seen.has(key(entry)), `stale census entry ${key(entry)} is no longer in the tree`)
  const counts = CENSUS.reduce((all, entry) => ({ ...all, [entry[4]]: (all[entry[4]] ?? 0) + 1 }), {})
  assert.equal(counts.gate, GATES.length)
  // S5r: the verifier reproduced two false labels. `operations` loses a write
  // when it is cleared while dispose() runs, and `releasedPasses` loses the only
  // record that an abandoned pass was released. Both are now labelled and their
  // tests exercise a non-empty loss; the count is machine-checked so the class
  // cannot grow silently.
  assert.equal(GATES.filter(entry => entry[5] === 'unsafe-in-memory').length, 5,
    'exactly five runtime collections are neither derivable nor cache-only; a new one must be reported, not labelled into silence')
  assert.equal(GATES.filter(entry => entry[5] === 'unsafe-in-memory').map(key).join(','),
    'src/runtime.ts:2,src/runtime.ts:3,src/runtime.ts:4,src/runtime.ts:5,src/scheduling.ts:1')
})

test('S5 census: the round-13 `scheduled` Set stays deleted and the guard stays durable (T1, included here)', () => {
  const found = occurrences(join(PROJECT, 'src'))
  assert.equal(found.filter(([, , , source]) => /scheduled\s*=\s*new Set/.test(source)).length, 0,
    'the Row-13 in-memory scheduling guard must not come back; the guard is the durable `passes` row')
  const runtime = readFileSync(join(PROJECT, 'src/runtime.ts'), 'utf8')
  assert.match(runtime, /There is deliberately no in-memory `scheduled` Set/,
    'the deletion is documented at the field that used to hold it (T1, Round 13)')
})

/** One test body per gate entry. A test name is derived from the census entry. */
const GATE_TESTS = {
  'src/runtime.ts:1': async t => {
    const f = await setup()
    try {
      let notified = 0
      const off = f.runtime.subscribe(() => { notified += 1 })
      f.runtime.commit(f.mission.id, () => {})
      assert.equal(notified, 1, 'a live subscriber is notified of a commit')
      const before = f.runtime.mission(f.mission.id).updatedAt
      assert.ok(f.runtime.listeners.size > 0, 'the loss must be exercised on a non-empty collection')
      f.runtime.listeners.clear()   // the loss
      f.runtime.commit(f.mission.id, () => { const mission = f.runtime.mission(f.mission.id); mission.updatedAt = before + 1; f.runtime.store.put('missions', mission) })
      assert.equal(f.runtime.mission(f.mission.id).updatedAt, before + 1, 'the durable write is unaffected by the lost fan-out')
      let after = 0
      f.runtime.subscribe(() => { after += 1 })
      f.runtime.commit(f.mission.id, () => {})
      assert.equal(after, 1, 'a fresh subscription receives later commits, so no state lived only in the lost listeners')
      off()
    } finally { await f.cleanup() }
  },
  'src/runtime.ts:2': async t => {
    const f = await setup({ config: { tickMs: 10, stallPassTimeoutMs: 50 } })
    try {
      // Live work: a running attempt with a live lease, which is exactly what
      // makes the pass watchdog keep the chain instead of releasing it.
      const task = f.propose({ title: 'Live work under a wedged queue' })
      await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
      // WEDGE: one queued body that never settles, with the durable pass row
      // running past the declared bound, exactly the F21 injection shape.
      void f.runtime.exclusive(f.mission.id, () => new Promise(() => {}))
      await eventually(() => {
        const row = f.runtime.store.get('passes', `pass_${f.mission.id}`)
        return row?.status === 'running' && Date.now() - row.startedAt > 50 ? row : undefined
      }, 'a pass row is running past its declared bound')
      const swallowed = await Promise.race([
        f.runtime.exclusive(f.mission.id, async () => 'ran'),
        new Promise(resolve => setTimeout(() => resolve('SWALLOWED'), 300)),
      ])
      // PROBE (hand-off): the pass watchdog only deletes the chain entry when the
      // mission has NO live work (checkSchedulingPasses). With a live lease it
      // deliberately keeps waiting, so a hung *non-pass* operation (submit,
      // verify, captureArtifact) keeps every later mission operation chained
      // behind a promise that never settles — the Row-13 shape, narrowed to that
      // window. The hand-off gives `exclusive` its own declared bound; when it
      // lands this assertion inverts to 'ran' and the entry becomes cache-only.
      assert.equal(swallowed, 'SWALLOWED', 'PROBE: with live work, a wedged queued body swallows the next mission operation')
      assert.ok(f.runtime.queues.has(f.mission.id), 'the watchdog kept the chain because the mission has live work')
      // The release half works: end the live work and the same watchdog deletes
      // the chain, so a later operation starts on a fresh chain and runs.
      f.runtime.cancel(f.owner, f.mission.id, { taskId: task.id, reason: 'S5: end the live work' })
      const released = await eventually(async () => {
        const outcome = await Promise.race([
          f.runtime.exclusive(f.mission.id, async () => 'ran'),
          new Promise(resolve => setTimeout(() => resolve(undefined), 60)),
        ])
        return outcome === 'ran' ? 'ran' : undefined
      }, 'once the live work ends the watchdog releases the chain, so a later operation runs', 4_000)
      assert.equal(released, 'ran', 'the release affects later operations, not one already queued behind the wedge')
      const rejected = await f.runtime.exclusive(f.mission.id, () => { throw new Error('probe rejection') }).then(() => 'resolved', error => `rejected:${error.message}`)
      assert.equal(rejected, 'rejected:probe rejection', 'a rejected body does not swallow the chain')
      assert.equal(await f.runtime.exclusive(f.mission.id, async () => 'ran'), 'ran', 'the chain continues after a rejection')
    } finally { await f.cleanup() }
  },
  'src/runtime.ts:3': async t => {
    // First half: the deferred body is independent of the registry, so a cleared
    // registry does not cancel work that dispose() would have drained.
    const f = await setup()
    try {
      const stamp = f.runtime.mission(f.mission.id).updatedAt
      let releaseOp
      const opGate = new Promise(resolve => { releaseOp = resolve })
      f.runtime.defer(async () => {
        await opGate
        const mission = f.runtime.mission(f.mission.id)
        mission.updatedAt = stamp + 5
        f.runtime.commit(f.mission.id, () => f.runtime.store.put('missions', mission))
      })
      assert.ok(f.runtime.operations.size > 0, 'the gated deferred write is registered; the loss must be exercised on a non-empty collection')
      f.runtime.operations.clear()   // the loss
      releaseOp()
      await eventually(() => f.runtime.mission(f.mission.id).updatedAt === stamp + 5,
        'the deferred write still lands after the registry is cleared')
    } finally { await f.cleanup() }
    // Second half (the actual loss): the registry is what makes dispose wait for
    // a deferred write, and defer runs its body after the caller returned.
    const g = await setup()
    try {
      let landed = false
      let releaseLate
      const lateGate = new Promise(resolve => { releaseLate = resolve })
      g.runtime.defer(async () => {
        await lateGate
        const mission = g.runtime.mission(g.mission.id)
        mission.updatedAt = Date.now() + 7
        try { g.runtime.commit(g.mission.id, () => g.runtime.store.put('missions', mission)); landed = true }
        catch { /* the store was closed under the write: this is the loss */ }
      })
      assert.ok(g.runtime.operations.size > 0, 'the gated deferred write is registered; the loss must be exercised on a non-empty collection')
      g.runtime.operations.clear()   // the loss
      await g.runtime.dispose()
      releaseLate()
      await new Promise(resolve => setTimeout(resolve, 40))
      assert.equal(landed, false,
        'PROBE: with the registry cleared, dispose() closes the store before the deferred write lands, so an accepted-looking write is lost')
    } finally { await g.cleanup() }
  },
  'src/runtime.ts:4': async t => {
    const f = await setup()
    try {
      const first = f.runtime.requestStart(f.owner, { commandId: 's5-controllers-1', goal: 'probe', workspace: f.dir })
      const controller = new AbortController()
      f.runtime.startControllers.set(first.id, controller)
      f.runtime.failStart(f.owner, first.id, 'injected failure')
      assert.equal(controller.signal.aborted, true, 'with the handle present, failing the request cancels the in-flight launch')
      const second = f.runtime.requestStart(f.owner, { commandId: 's5-controllers-2', goal: 'probe', workspace: f.dir })
      const lost = new AbortController()
      f.runtime.startControllers.set(second.id, lost)
      assert.ok(f.runtime.startControllers.size > 0, 'the loss must be exercised on a non-empty collection')
      f.runtime.startControllers.clear()   // the loss
      f.runtime.failStart(f.owner, second.id, 'injected failure')
      assert.equal(lost.signal.aborted, false, 'PROBE: with the registry lost, the in-flight launch is no longer cancellable')
      assert.equal(f.runtime.store.get('starts', second.id).status, 'failed', 'the durable failure is independent of the lost handle')
    } finally { await f.cleanup() }
  },
  'src/runtime.ts:5': async t => {
    // Control: with the counter intact, consecutive start failures retire the member.
    const control = await setup()
    let retired
    try {
      for (let attempt = 0; attempt < 10 && retired !== 'stopped'; attempt += 1) {
        control.runtime.onStartFailure(control.mission, control.author, new Error('injected start failure'))
        retired = control.runtime.store.get('members', control.author.id).status
      }
      assert.equal(retired, 'stopped', 'the in-memory counter retires a member after the declared consecutive failures')
      const count = control.runtime.startFailures.get(control.author.id)
      assert.ok(count >= 1)
    } finally { await control.cleanup() }
    // Falsification: lose the counter and the same third failure no longer retires.
    const f = await setup()
    try {
      const first = f.propose()
      f.runtime.onStartFailure(f.mission, f.author, new Error('injected start failure'))
      f.runtime.onStartFailure(f.mission, f.author, new Error('injected start failure'))
      assert.equal(f.runtime.startFailures.get(f.author.id), 2, 'two consecutive failures are held in memory')
      assert.equal(f.runtime.store.get('members', f.author.id).status, 'idle', 'below the limit the member stays live')
      assert.ok(f.runtime.startFailures.size > 0, 'the loss must be exercised on a non-empty collection')
      f.runtime.startFailures.clear()   // the loss
      f.runtime.onStartFailure(f.mission, f.author, new Error('injected start failure'))
      assert.equal(f.runtime.store.get('members', f.author.id).status, 'idle',
        'PROBE: with the counter lost, the failure that would have retired the member keeps it live instead')
      assert.equal(f.runtime.startFailures.get(f.author.id), 1, 'the counter restarts from one')
      const recorded = events(f.runtime, f.mission.id, 'task/start-failed')
      assert.deepEqual(recorded.map(event => event.data.consecutiveFailures), [1, 2, 1],
        'the durable log carries the real counts, so the counter is derivable; the third row restarts at one only because the memory was lost')
    } finally { await f.cleanup() }
  },
  'src/runtime.ts:6': async t => {
    const f = await setup()
    try {
      const actor = { sessionId: f.author.sessionId }
      const first = f.runtime.observe(actor, f.mission.id)
      assert.ok(f.runtime.observeCursors.get(f.author.id) !== undefined, 'a member read records a delivered cursor')
      const durableEvents = f.runtime.store.events(f.mission.id, 500)
      assert.ok(f.runtime.observeCursors.size > 0, 'the loss must be exercised on a non-empty collection')
      f.runtime.observeCursors.clear()   // the loss
      const second = f.runtime.observe(actor, f.mission.id)
      assert.equal(second.events.length, first.events.length, 'the lost cursor re-delivers the same bounded window')
      assert.equal(f.runtime.store.events(f.mission.id, 500).length, durableEvents.length, 'and no durable event is changed or lost')
      const cursor = f.runtime.observeCursors.get(f.author.id)
      assert.ok(cursor.eventSeq <= durableEvents.at(-1).seq, 'a cursor can never exceed the durable log, so presence cannot hide an event')
    } finally { await f.cleanup() }
  },
  'src/runtime.ts:7': async t => {
    // The durable `task/review-admitted` event is the gate: a withdrawn review
    // still blocks with the map cleared, and a phantom map entry cannot block.
    const f = await setup({ config: { tickMs: 10 } })
    try {
      const task = f.propose({ title: 'Withdrawn review' })
      const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
      await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
      const review = await eventually(() => f.runtime.store.list('tasks', f.mission.id).find(item => item.kind === 'verification' && item.reviewOf === task.id),
        'the automatic review is admitted')
      f.runtime.cancel(f.owner, f.mission.id, { taskId: review.id, reason: 'S5: withdraw the automatic review' })
      assert.ok(f.runtime.autoReviewAdmissions.size > 0, 'the automatic admission is cached; the loss must be exercised on a non-empty collection')
      f.runtime.autoReviewAdmissions.clear()   // the loss
      const blocked = await eventually(() => events(f.runtime, f.mission.id, 'task/review-blocked').at(-1),
        'the withdrawal blocker is re-derived from the durable admission event')
      assert.match(blocked.data.reason, /withdrawn/, 'the gate follows the durable event, not the lost map')
    } finally { await f.cleanup() }
    const phantom = await setup({ config: { tickMs: 10 } })
    try {
      const task = phantom.propose({ title: 'Phantom map entry' })
      phantom.runtime.autoReviewAdmissions.set(task.id, 'task_phantom')
      const claimed = await phantom.runtime.claim(phantom.actor(phantom.author), phantom.mission.id, task.id)
      await phantom.runtime.submit(phantom.actor(phantom.author), phantom.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
      const review = await eventually(() => phantom.runtime.store.list('tasks', phantom.mission.id).find(item => item.kind === 'verification' && item.reviewOf === task.id),
        'a map entry with no durable admission cannot block a legitimate automatic review')
      assert.notEqual(review.id, 'task_phantom')
    } finally { await phantom.cleanup() }
  },
  'src/runtime.ts:8': async t => {
    const f = await setup({ config: { tickMs: 10 } })
    try {
      const task = f.propose({ title: 'Missing review record' })
      const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
      await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
      const submission = await eventually(() => events(f.runtime, f.mission.id, 'task/submitted').at(-1), 'the submission is recorded durably')
      f.runtime.reviewPathReported.add(`${f.mission.id}:${task.id}:${submission.seq}`)   // phantom presence
      const missing = await eventually(() => events(f.runtime, f.mission.id, 'task/review-missing').at(-1),
        'the missing-review record is written from the durable submission even though the cache claims it was reported')
      assert.equal(missing.data.taskId, task.id, 'the set cannot swallow the durable missing-review record')
    } finally { await f.cleanup() }
  },
  'src/gates.ts:1': async t => {
    const f = await setup()
    try {
      const before = f.runtime.fingerprint(f.mission.id)
      assert.ok(f.runtime.fingerprintCache.size > 0, 'the loss must be exercised on a non-empty collection')
      f.runtime.fingerprintCache.clear()   // the loss
      assert.equal(f.runtime.fingerprint(f.mission.id), before, 'the digest is recomputed from durable state and is identical')
      let inside
      const task = f.propose({ title: 'Board change' })
      f.runtime.commit(f.mission.id, () => {
        const record = f.runtime.store.get('tasks', task.id)
        record.status = 'cancelled'
        f.runtime.store.putTask(record)
        inside = f.runtime.fingerprint(f.mission.id)
      })
      const after = f.runtime.fingerprint(f.mission.id)
      assert.notEqual(after, before, 'a changed board changes the digest')
      assert.equal(inside, after, 'inside a transaction the cache is bypassed (commitDepth), so it can never gate on a stale board')
    } finally { await f.cleanup() }
  },
  'src/gates.ts:2': async t => {
    const f = await setup({ config: { tickMs: 10 } })
    try {
      // Gate the adapter stop so the claim window is observable: the Set is
      // provably non-empty when the loss is injected, and the stop is in flight.
      let releaseStop
      const stopGate = new Promise(resolve => { releaseStop = resolve })
      let stopCalls = 0
      f.workers.stop = async () => { stopCalls += 1; await stopGate }
      f.runtime.store.transaction(() => { const mission = f.runtime.mission(f.mission.id); mission.usedTokens = mission.budget.maxTokens; f.runtime.store.put('missions', mission) })
      await eventually(() => f.runtime.mission(f.mission.id).status === 'blocked', 'the exhausted budget blocks the mission')
      const pauseId = f.runtime.mission(f.mission.id).budgetPause.id
      await eventually(() => f.runtime.budgetStops.size > 0, 'the in-flight stop is mirrored')
      assert.ok(f.runtime.budgetStops.size > 0, 'the loss must be exercised on a non-empty collection')
      assert.equal(f.runtime.mission(f.mission.id).budgetPause.stopping?.instanceId, f.runtime.instanceId,
        'the durable claim is written before the stop awaits the adapter')
      // THE LOSS: drop the mirror while the stop is in flight, then ask for the
      // same stop again. The durable claim, not the Set, must absorb it.
      f.runtime.budgetStops.clear()
      f.runtime.beginBudgetStop(f.mission.id, pauseId)
      releaseStop()
      await eventually(() => f.runtime.mission(f.mission.id).budgetPause?.quiesced === true, 'the stop completes')
      await new Promise(resolve => setTimeout(resolve, 80))
      assert.equal(events(f.runtime, f.mission.id, 'mission/budget-quiesced').length, 1,
        'the durable claim absorbs the duplicate: exactly one quiesced event')
      assert.equal(events(f.runtime, f.mission.id, 'mission/budget-exhausted').length, 1)
      assert.equal(stopCalls, 2, 'the duplicate request stopped no member a second time')
      assert.equal(f.runtime.mission(f.mission.id).budgetPause.stopping, undefined, 'the completed stop clears its claim')
    } finally { await f.cleanup() }
    // Bounded claim: a crashed stop (foreign instance, older than the declared
    // pass bound) must not gate a fresh attempt forever.
    const crashed = await setup()
    try {
      crashed.runtime.store.transaction(() => {
        const mission = crashed.runtime.mission(crashed.mission.id)
        mission.status = 'blocked'
        mission.budgetPause = { id: 'pause-crashed', quiesced: false, stopping: { instanceId: 'other-runtime', at: Date.now() - 60_000 } }
        crashed.runtime.store.put('missions', mission)
      })
      crashed.runtime.beginBudgetStop(crashed.mission.id, 'pause-crashed')
      await eventually(() => crashed.runtime.mission(crashed.mission.id).budgetPause?.quiesced === true,
        'a foreign, expired claim does not gate the stop')
      assert.equal(events(crashed.runtime, crashed.mission.id, 'mission/budget-quiesced').length, 1)
    } finally { await crashed.cleanup() }
  },
  'src/attempts.ts:1': async t => {
    const f = await setup({ config: { tickMs: 10 } })
    try {
      const task = f.propose({ title: 'Idle close-out' })
      await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
      await f.workers.callbacks.idle(f.author.id)
      const signal = taskOf(f.runtime, task.id).idleSignal
      assert.ok(signal?.attemptId, 'the durable `Task.idleSignal` carries the same value the map held')
      assert.equal(f.runtime.idleSignals.get(f.author.id)?.attemptId, signal.attemptId)
      assert.ok(f.runtime.idleSignals.size > 0, 'the loss must be exercised on a non-empty collection')
      f.runtime.idleSignals.clear()   // the loss
      // Dispatch must be able to reach the open attempt for the durable signal
      // to be consulted at all.
      f.workers.autoIdle = true
      const closed = await eventually(() => {
        const current = taskOf(f.runtime, task.id)
        const closedOut = events(f.runtime, f.mission.id, 'task/checkpointed').length > 0
          || events(f.runtime, f.mission.id, 'task/closeout-failed').length > 0
          || events(f.runtime, f.mission.id, 'task/closeout-abandoned').length > 0
        return closedOut ? current : undefined
      }, 'the scheduling pass re-reads the durable signal and closes the idle attempt out')
      assert.ok(closed)
    } finally { await f.cleanup() }
  },
  'src/notices.ts:1': async t => {
    const f = await setup({ config: { tickMs: 10 } })
    try {
      const task = f.propose({ title: 'Parked holder' })
      await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
      const epoch = taskOf(f.runtime, task.id).epoch
      // Phantom presence: the set claims the notice for this attempt was sent,
      // but the durable delivery ledger has no such notice.
      f.runtime.parkedNotices.add(`parked:${f.mission.id}:${task.id}:${epoch}`)
      f.runtime.store.transaction(() => { const member = f.runtime.store.get('members', f.author.id); member.status = 'waiting'; f.runtime.store.put('members', member) })
      const notice = await eventually(() => f.runtime.store.list('deliveries', f.mission.id).find(delivery => delivery.to === 'owner' && /parked member/.test(delivery.content)),
        'the parked-holder notice is emitted from the durable state despite the phantom cache entry')
      assert.equal(notice.notice.dedupKey, `parked:${f.mission.id}:${task.id}:${epoch}`, 'the durable ledger is the gate')
    } finally { await f.cleanup() }
  },
  'src/notices.ts:2': async t => {
    const f = await setup()
    try {
      f.runtime.integrationGapWarned.add(`integration-gap:${f.mission.id}:2`)   // phantom presence
      f.propose({ title: 'First implementation' })
      f.propose({ title: 'Second implementation' })
      const notice = await eventually(() => f.runtime.store.list('deliveries', f.mission.id).find(delivery => delivery.notice?.dedupKey === `integration-gap:${f.mission.id}:2`),
        'the integration-gap notice is emitted because the durable ledger has no such row')
      assert.ok(notice)
    } finally { await f.cleanup() }
  },
  'src/notices.ts:3': async t => {
    const f = await setup({ config: { tickMs: 10 } })
    try {
      const task = f.propose({ title: 'Blocked review path' })
      const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
      await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
      const review = await eventually(() => f.runtime.store.list('tasks', f.mission.id).find(item => item.kind === 'verification' && item.reviewOf === task.id),
        'the automatic review is admitted')
      // The blocker reason is deterministic; seed the set with the exact key
      // before the review is withdrawn, so the cache claims the notice was sent.
      const reason = `the automatically admitted review ${review.id} was withdrawn; admit a replacement review (kind verification, reviewOf ${task.id}) or cancel the source task`
      f.runtime.reviewPathNotices.add(`review-blocked:${f.mission.id}:${task.id}:${reason}`)
      f.runtime.cancel(f.owner, f.mission.id, { taskId: review.id, reason: 'S5: withdraw' })
      const delivery = await eventually(() => f.runtime.store.list('deliveries', f.mission.id).find(item => item.notice?.dedupKey === `review-blocked:${f.mission.id}:${task.id}:${reason}`),
        'the durable ledger, not the set, decides whether the blocked-review notice is sent')
      assert.ok(delivery)
    } finally { await f.cleanup() }
  },
  'src/notices.ts:4': async t => {
    const f = await setup({ config: { tickMs: 10, stallPassTimeoutMs: 100 } })
    try {
      const first = f.propose({ title: 'Notice' })
      await f.runtime.commit(f.mission.id, () => f.runtime.notify(f.mission.id, 'S5 outbox probe', 'runtime', 'decision', false))
      const queued = f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner')
      assert.ok(queued.length >= 1)
      // Gate the adapter delivery, so the per-attempt claim is observable and
      // provably NON-EMPTY at the moment it is cleared.
      let releaseDeliver
      const gate = new Promise(resolve => { releaseDeliver = resolve })
      let attempts = 0
      f.workers.deliver = async () => { attempts += 1; await gate }
      const pumping = f.runtime.flushOutbox(f.mission.id)
      await eventually(() => f.runtime.notices.delivering.size === 1, 'the pump claims the delivery')
      assert.ok(f.runtime.notices.delivering.size > 0, 'the loss must be exercised on a non-empty collection')
      f.runtime.notices.delivering.clear()   // the loss
      // A second pump now starts while the first is still gated: the lost claim
      // makes the same delivery be attempted twice (duplicated idempotent work),
      // never written twice.
      const duplicate = f.runtime.flushOutbox(f.mission.id)
      await eventually(() => attempts >= 2, 'the lost claim lets a second pump attempt the same delivery')
      releaseDeliver()
      await Promise.all([pumping, duplicate])
      const rows = f.runtime.store.list('deliveries', f.mission.id)
      assert.equal(rows.filter(delivery => delivery.id === queued[0].id).length, 1, 'the claim map is per attempt: no durable duplicate row is created')
      assert.ok(rows.find(delivery => delivery.id === queued[0].id).deliveredAt !== undefined, 'the row is delivered and stamped exactly once')
      assert.equal(taskOf(f.runtime, first.id).status, 'pending')
    } finally { await f.cleanup() }
  },
  'src/scheduling.ts:1': async t => {
    const f = await setup({ config: { tickMs: 10 } })
    try {
      f.workers.autoIdle = true
      const task = f.propose({ title: 'Abandoned pass body' })
      // The abandoned pass body a watchdog released after its bound: the same
      // object `Scheduling.dispatch(mission, missionId, pass)` receives.
      const abandonedPass = {
        id: `pass_${f.mission.id}`, runId: 'abandoned-pass-run', instanceId: f.runtime.instanceId, missionId: f.mission.id,
        status: 'running', startedAt: Date.now() - 60_000, revisionBefore: f.runtime.store.revision(),
        fingerprintBefore: f.runtime.fingerprint(f.mission.id), noProgressPasses: 0,
      }
      f.runtime.releasedPasses.add(abandonedPass.runId)
      assert.ok(f.runtime.releasedPasses.size > 0, 'the loss must be exercised on a non-empty collection')
      assert.equal(await f.runtime.scheduling.dispatch(f.mission, f.mission.id, abandonedPass), false,
        'while the release is recorded, the abandoned pass body is fenced and dispatches nothing')
      assert.equal(taskOf(f.runtime, task.id).status, 'pending', 'the fenced body changed no task state')
      // THE LOSS: the in-memory Set is the only record that this pass was
      // released. `passReleased` (src/scheduling.ts) reads it, so clearing it
      // lets the abandoned body resume — the Row-13 class this census exists for.
      f.runtime.releasedPasses.clear()
      assert.equal(await f.runtime.scheduling.dispatch(f.mission, f.mission.id, abandonedPass), true,
        'PROBE: with the Set cleared, the abandoned pass body is no longer fenced')
      assert.equal(taskOf(f.runtime, task.id).status, 'running',
        'PROBE: and it drives the task to running with a live attempt')
      assert.ok(taskOf(f.runtime, task.id).attempt?.leaseUntil > Date.now(), 'the resumed body assigned a real attempt')
    } finally { await f.cleanup() }
  },
  'src/store.ts:1': async t => {
    const f = await setup()
    try {
      const store = f.runtime.store
      let notified = 0
      const off = store.subscribe(() => { notified += 1 })
      store.transaction(() => { const mission = f.runtime.mission(f.mission.id); mission.updatedAt = Date.now(); store.put('missions', mission) })
      assert.equal(notified, 1, 'a live store subscriber sees a committed mutation')
      const revision = store.revision()
      assert.ok(store.listeners.size > 0, 'the loss must be exercised on a non-empty collection')
      store.listeners.clear()   // the loss
      store.transaction(() => { const mission = f.runtime.mission(f.mission.id); mission.updatedAt = Date.now() + 1; store.put('missions', mission) })
      assert.equal(store.revision(), revision + 1, 'the committed revision still advances with the observers lost')
      assert.ok(store.changesSince(revision).length >= 1, 'the durable change cursor is unaffected')
      off()
    } finally { await f.cleanup() }
  },
  'src/workspace-admission.ts:6': async t => {
    const f = await setup()
    try {
      const durableBefore = f.runtime.store.events(f.mission.id, 500).length
      const probe = { tool: 'bash', arguments: { command: 'cat /tmp/s5-inventory-rendezvous' } }
      assert.equal(f.runtime.tempRendezvous(f.author.id, 'task_a', probe), undefined, 'a single mention is not a rendezvous')
      const report = f.runtime.tempRendezvous(f.reviewer.id, 'task_b', probe)
      assert.ok(report, 'two members naming the same shared temp path are reported')
      assert.ok(f.runtime.workspaceAdmission.tempMentions.size > 0, 'the loss must be exercised on a non-empty collection')
      f.runtime.workspaceAdmission.tempMentions.clear()   // the loss
      const again = f.runtime.tempRendezvous(f.reviewer.id, 'task_b', probe)
      assert.equal(again, undefined, 'with the bounded mention window lost there is nothing left to compare, so no advisory warning is raised')
      assert.equal(f.runtime.store.events(f.mission.id, 500).length, durableBefore,
        'and no durable outcome changed: the window is an advisory cache over wall-clock mentions')
    } finally { await f.cleanup() }
  },
  'src/workspace-admission.ts:7': async t => {
    const f = await setup()
    try {
      const durableBefore = f.runtime.store.events(f.mission.id, 500).length
      const probe = { tool: 'bash', arguments: { command: 'cat /tmp/s5-inventory-rendezvous-dedup' } }
      f.runtime.tempRendezvous(f.author.id, 'task_a', probe)
      const first = f.runtime.tempRendezvous(f.reviewer.id, 'task_b', probe)
      assert.ok(first, 'the first rendezvous is reported')
      const suppressed = f.runtime.tempRendezvous(f.reviewer.id, 'task_b', probe)
      assert.equal(suppressed, undefined, 'the reported-pair window suppresses a repeat inside the window')
      assert.ok(f.runtime.workspaceAdmission.tempRendezvousReported.size > 0, 'the loss must be exercised on a non-empty collection')
      f.runtime.workspaceAdmission.tempRendezvousReported.clear()   // the loss
      const rearmed = f.runtime.tempRendezvous(f.reviewer.id, 'task_b', probe)
      assert.ok(rearmed, 'losing the dedup window re-arms the advisory warning instead of changing a durable outcome')
      assert.equal(f.runtime.store.events(f.mission.id, 500).length, durableBefore, 'the durable record is unchanged either way')
    } finally { await f.cleanup() }
  },
}

test('S5 D1 pin (KNOWN GAP, hand-off): the stale-revision refusal event is not in EVENT_VOCABULARY yet', async () => {
  // The refusal type is emitted through the exported constant
  // `STALE_TASK_REFUSAL_EVENT`, so the static emitter scan in
  // tests/event-vocabulary.test.mjs cannot see it and the vocabulary is missing
  // an entry the runtime really emits (verifier-1's reproduction,
  // evidence_110873e2). Registering it is a src/trace.ts change outside the S5
  // scope; this pin fails the moment it is registered, which is exactly when the
  // assertion must be deleted.
  const { EVENT_VOCABULARY } = await import('../lib/trace.js')
  const { STALE_TASK_REFUSAL_EVENT } = await import('../lib/store.js')
  assert.equal(STALE_TASK_REFUSAL_EVENT, 'task/stale-revision-refused')
  assert.equal(EVENT_VOCABULARY[STALE_TASK_REFUSAL_EVENT], undefined,
    'KNOWN GAP (hand-off): register task/stale-revision-refused in src/trace.ts EVENT_VOCABULARY and delete this assertion')
})

test('S5 inventory: every gate entry has exactly one test', () => {
  for (const entry of GATES) assert.equal(typeof GATE_TESTS[key(entry)], 'function', `${key(entry)} is labelled a gate, so it needs a test body`)
  for (const entry of Object.keys(GATE_TESTS)) assert.ok(GATES.some(candidate => key(candidate) === entry), `${entry} has a test but is not a labelled gate entry`)
})

for (const [entryKey, body] of Object.entries(GATE_TESTS)) {
  const entry = CENSUS.find(candidate => key(candidate) === entryKey)
  test(`S5 gate ${entryKey} [${entry[5]}] — ${entry[0].replace('src/', '')}`, body)
}
