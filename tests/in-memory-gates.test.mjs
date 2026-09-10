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
 * A third label was possible while a gate was neither; S5c closed it. Every
 * behaviour-gating entry in `src/` is now `derivable` or `cache-only`, and the
 * census test asserts that by NAME for the five entries that used to be reported
 * as neither (`queues`, `operations`, `startControllers`, `startFailures`,
 * `releasedPasses`): a new unlabelled state cannot hide behind an edited count.
 * The five fixes are structural, not re-labelling — the mission queue no longer
 * chains past the declared bound, the launch's cancellation is re-read from the
 * durable start row before activation, the consecutive-failure count lives on
 * the member row, every deferred body re-derives from durable state, and the
 * pass watchdog stamps `releasedRunId` on the durable pass row.
 *
 * Co-firing guards (every guard must name what it can fire with):
 *  - the per-task revision CAS in `SwarmStore.putTask` fires with the mission
 *    queue (`queues`), the fingerprint cache and the writer-busy retry; the pair
 *    tests live in `tests/task-revision.test.mjs`;
 *  - the fingerprint cache fires with `commitDepth` (bypassed inside a
 *    transaction) — pinned below;
 *  - the notice-dedup sets fire with the durable delivery ledger — pinned below;
 *  - the durable pass-release fence fires with the pass watchdog
 *    (`checkSchedulingPasses`), the mission queue's bound and `openPass`'s
 *    carry-forward — pinned in the `releasedPasses` test below.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import { setup, eventually, events, taskOf, FakeWorkers, SwarmRuntime } from './faults/harness.mjs'

const PROJECT = fileURLToPath(new URL('../', import.meta.url))

/** A settable promise gate, so a test owns the in-flight window it asserts on. */
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

/**
 * S5c: a worker adapter whose workspace preparation can be held open, so the
 * launch-cancellation test owns the window in which a launch is in flight.
 */
class GatedWorkers extends FakeWorkers {
  prepareStarted = 0
  prepareGate
  async prepareWorkspace(mission, memberId) {
    this.prepareStarted += 1
    if (this.prepareGate) await this.prepareGate
    return join(mission.workspace, memberId)
  }
}

/** A valid automatic plan (the shape `startPlan` accepts), copied from tests/automatic.test.mjs. */
function automaticPlan(workspace) {
  const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 12, maxExperiments: 2 }
  return {
    title: 'Automatic delivery', objective: 'Deliver verified code', workspace, scope: ['src/'], acceptance: ['works'], budget,
    members: [{ key: 'builder', name: 'Builder', role: 'implementation', maxOutputTokens: 4096 }, { key: 'reviewer', name: 'Reviewer', role: 'verification', maxOutputTokens: 2048 }],
    workstreams: [{ key: 'main', title: 'Delivery', objective: 'Complete the change' }],
    tasks: [
      { key: 'deliver', workstreamKey: 'main', title: 'Deliver', objective: 'Implement final change', kind: 'integration', scope: ['src/'], acceptance: ['works'], assigneeKey: 'builder', checks: ['node check.cjs'], maxRecoveryAttempts: 5, checkTimeoutMs: 45000 },
      { key: 'review', workstreamKey: 'main', title: 'Review', objective: 'Verify immutable artifact', kind: 'verification', scope: ['src/'], acceptance: ['works'], assigneeKey: 'reviewer', reviewOf: 'deliver', maxRecoveryAttempts: 5 },
    ],
  }
}

/**
 * Exhaustive census, keyed by [file, occurrence index within the file, constructor, source, class, label, reason].
 * The occurrence index (not the line number) is the key, so an unrelated edit
 * above an entry does not invalidate it; the source text is checked too, so a
 * rewritten entry is reported instead of silently re-classified.
 */
const CENSUS = [
  ["src/admission.ts",1,"Set","const knownIds = known ?? new Set(nodes.map(node => node.id))","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/admission.ts",2,"Set","const seen = new Set<string>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/admission.ts",3,"Map","const byId = new Map(nodes.map(node => [node.id, node]))","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/admission.ts",4,"Set","const open = new Set<string>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/admission.ts",5,"Set","const done = new Set<string>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/admission.ts",6,"Set","const WRITE_VERBS = new Set([","constant","","module-level immutable lookup table, never mutated after construction: data, not a gate"],
  ["src/admission.ts",7,"Set","const seen = new Set<string>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/admission.ts",8,"Set","const seen = new Set<string>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/admission.ts",9,"Set","const seen = new Set<string>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/admission.ts",10,"Set","const candidates = [...new Set(paths.map(path => path.replace(/^\\.\\//, '')).filter(path => path && !path.endsWith('/') && !isAbsolute(path) && !path.includes('*') && !path.split('/').some(part => part === '..')))]","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/admission.ts",11,"Set","const hidden = new Set(String(ignored.stdout).split('\\0').filter(Boolean))","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/admission.ts",12,"Set","const replaces = new Set(context.replaces ?? task.replaces ?? [])","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/admission.ts",13,"Set","const seen = new Set<string>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/admission.ts",14,"Set","const resolved = resolveHostOnlyScript(command, scripts, new Set(), 0)","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/admission.ts",15,"Set","const SHELL_WORD_OPERATORS = new Set([';', '&', '|', '(', ')', '<', '>', '\\n'])","constant","","module-level immutable lookup table, never mutated after construction: data, not a gate"],
  ["src/admission.ts",16,"Set","const seen = new Set<string>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/arena.ts",1,"Set","export function liveCarrier(tasks: readonly Task[], dependencyId: string, seen: Set<string> = new Set()): Task | undefined {","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/attempts.ts",1,"Map","readonly idleSignals = new Map<string, { attemptId: string; at: number }>()","gate","cache-only","the durable Task.idleSignal carries the same value and the scheduling pass re-reads it"],
  ["src/attempts.ts",2,"Set","if (owner !== undefined) task.priorOwnerIds = [...new Set([...(task.priorOwnerIds ?? []), owner])]","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/declared-checks.ts",1,"Map","private readonly checkRuns = new Map<string, CheckResult[][]>()","outside","","outside the runtime decision path: the declared-check runner (DeclaredChecks) below the runtime, reached through the verification adapter; the in-memory hold carries the FIRST failed pass until recordRuns() writes the pair, so losing it under-records that pair without changing the verdict (enumerated, no label claimed)"],
  ["src/delivery.ts",1,"Set","const activeSources = new Set<string>()","outside","","outside the runtime decision path: the delivery engine module (applyDelivery); the runtime serializes applies per workspace through exclusive(\"delivery:<workspace>\"), so the runtime path does not depend on this process-global mutex (enumerated, no label claimed)"],
  ["src/delivery.ts",2,"Map","const sourceIdentities = new Map<string, string>()","outside","","outside the runtime decision path: the delivery engine module (applyDelivery); the runtime serializes applies per workspace through exclusive(\"delivery:<workspace>\"), so the runtime path does not depend on this process-global mutex (enumerated, no label claimed)"],
  ["src/delivery.ts",3,"Set","const FALLBACK_TEMP_CODES = new Set(['EPERM', 'EACCES', 'ENOENT', 'ENOTDIR'])","constant","","module-level immutable lookup table, never mutated after construction: the errno allowlist the R15-F5 temp-root fallback decides on, data rather than a gate"],
  ["src/gates.ts",1,"Map","readonly fingerprintCache = new Map<string, { revision: number; fingerprint: string }>()","gate","cache-only","keyed by the global store revision; the digest is pure over durable state and is bypassed inside a transaction"],
  ["src/gates.ts",2,"Set","readonly budgetStops = new Set<string>()","gate","cache-only","S5r: the durable `budgetPause.stopping` claim (written before the first await, bounded like the pass guard) is the gate; the Set is only the public mirror `SwarmRuntime.budgetStops` names and is never read to decide whether a stop may run"],
  ["src/gates.ts",3,"Set","const ready = new Set(tasks.filter(task => task.status === 'pending' && runnable.some(member => this.rt.ready(task, member, tasks))).map(task => task.id))","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/gates.ts",4,"Set","const unreviewed = new Set(tasks.filter(task => task.status === 'submitted' && !this.rt.reviewable(task, tasks)).map(task => task.id))","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/git-snapshot.ts",1,"Set","const trackedSet = new Set(tracked)","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/git-snapshot.ts",2,"Set","const headPaths = new Set(headEntries.map(entry => entry.slice(entry.indexOf('\\t') + 1)))","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/git-snapshot.ts",3,"Map","const submodules = new Map(headEntries.filter(entry => entry.startsWith('160000 ')).map(entry => {","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/git-snapshot.ts",4,"Set","for (const filename of [...new Set([...headPaths, ...tracked, ...untracked])].sort()) {","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/harness-workers.ts",1,"Set","return overlay === undefined ? Reflect.ownKeys(target) : [...new Set([...Reflect.ownKeys(target), ...Object.keys(overlay)])]","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/harness-workers.ts",2,"Map","private readonly residents = new Map<string, Resident>()","outside","","outside the runtime decision path: the harness worker adapter (HarnessWorkers): resident handle, observation, delivered-message and recovery-inbox state for live host agents; the runtime reaches it only through the injected WorkerAdapter (enumerated, no label claimed)"],
  ["src/harness-workers.ts",3,"Set","const consumed = new Set(agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data.id))","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/harness-workers.ts",4,"Set","const pending = new Set([...agent.inbox.nextStep, ...agent.inbox.nextTurn].map(message => message.id))","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/harness-workers.ts",5,"Set","const resident: Resident = { spec, abort: new AbortController(), opening: Promise.resolve(), observations: new Set(), delivered: new Set(), recoveryInbox: new Map(), journalWrites: Promise.resolve(), totalTokens: 0, usage: emptyBuckets(), lastPromptTokens: 0, compactionRequested: false, recordedExecutions: new WeakSet(), rejectedPendingStep: false, activities: new Map() }","outside","","outside the runtime decision path: the harness worker adapter (HarnessWorkers): resident handle, observation, delivered-message and recovery-inbox state for live host agents; the runtime reaches it only through the injected WorkerAdapter (enumerated, no label claimed)"],
  ["src/harness-workers.ts",6,"Set","const visible = new Set(agentCtx.tools.schemas(agent).map(schema => schema.name))","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/harness-workers.ts",7,"Set","const claimedIds = new Set(messages.map(message => message.id))","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/notices.ts",1,"Set","const TERMINAL_STATES = new Set(['accepted', 'cancelled'])","constant","","module-level immutable lookup table, never mutated after construction: data, not a gate"],
  ["src/notices.ts",2,"Set","readonly parkedNotices = new Set<string>()","gate","derivable","the durable delivery ledger (class, dedupKey, sender) is the gate; the set only avoids the read"],
  ["src/notices.ts",3,"Set","readonly integrationGapWarned = new Set<string>()","gate","derivable","the durable delivery ledger is the gate; the set only avoids the read"],
  ["src/notices.ts",4,"Set","readonly reviewPathNotices = new Set<string>()","gate","derivable","the durable delivery ledger is the gate; the set only avoids the read"],
  ["src/notices.ts",5,"Map","private readonly delivering = new Map<string, number>()","gate","cache-only","per-attempt claim; the durable deliveredAt row is the real gate and adapter acceptance is idempotent"],
  ["src/notices.ts",6,"Set","const roots = new Set(this.stallRoots(tasks).map(task => task.id))","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/notices.ts",7,"Set","const replaced = new Set<string>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/notices.ts",8,"Map","const found = new Map<string, Task>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/plans.ts",1,"Map","const result = new Map<string, Record<string, unknown>>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/plans.ts",2,"Set","const names = new Set<string>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/plans.ts",3,"Map","const byKey = new Map(tasks.map(task => [task.key, task])), visiting = new Set<string>(), done = new Set<string>(), result: PlanTask[] = []","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/roles.ts",1,"Map","private readonly applied = new Map<string, Applied>()","outside","","outside the runtime decision path: the plugin composition tool-registration cache, not the runtime mission path (enumerated, no label claimed)"],
  ["src/roles.ts",2,"Set","const visible = new Set(agent.ctx.tools.schemas(agent).map(schema => schema.name))","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",1,"Set","const SELF_RUN_FACTS = new Set(['HOME', 'XDG_CACHE_HOME', 'npm_config_cache', 'YARN_CACHE_FOLDER', 'PIP_CACHE_DIR', 'GOCACHE'])","constant","","module-level immutable lookup table, never mutated after construction: data, not a gate"],
  ["src/runtime.ts",2,"Set","const SELF_RUN_ENV_COMMANDS = new Set(['env', 'export', 'unset'])","constant","","module-level immutable lookup table, never mutated after construction: data, not a gate"],
  ["src/runtime.ts",3,"Set","const SELF_RUN_SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh'])","constant","","module-level immutable lookup table, never mutated after construction: data, not a gate"],
  ["src/runtime.ts",4,"Set","const UNSET_VARIABLE_OPTIONS = new Set(['-v', '--'])","constant","","module-level immutable lookup table, never mutated after construction: data, not a gate"],
  ["src/runtime.ts",5,"Set","const ENV_CHDIR_OPTIONS = new Set(['-C', '--chdir'])","constant","","module-level immutable lookup table, never mutated after construction: data, not a gate"],
  ["src/runtime.ts",6,"Set","private readonly listeners = new Set<(missionId: string) => void>()","gate","cache-only","in-process change fan-out; a lost notification changes no durable state and a subscriber re-reads on its next request"],
  ["src/runtime.ts",7,"Map","readonly queues = new Map<string, Promise<unknown>>()","gate","cache-only","S5c: the chain is an in-process ordering cache. `exclusive` waits for a predecessor only up to the declared bound (stallPassTimeoutMs) and then starts the next operation, so a wedged body can no longer swallow it, and two bodies that overlap after the bound cannot lose an update because every commit is a single-writer transaction and every task write is a compare-and-swap on the task revision (SwarmStore.putTask). Clearing it removes ordering only, never a durable outcome (probe below)"],
  ["src/runtime.ts",8,"Set","private readonly operations = new Set<Promise<unknown>>()","gate","cache-only","S5c: the drain registry orders shutdown; the deferred body is registered by `defer` and runs regardless, so clearing the registry does not cancel it and its durable write still lands (probe below). Every deferred body the runtime schedules re-derives its work from durable state (the pass row, the budget `stopping` claim, the durable outbox), so losing the drain lets dispose() return earlier but cannot make a durable transition wrong"],
  ["src/runtime.ts",9,"Map","private readonly startControllers = new Map<string, AbortController>()","gate","derivable","S5c: the abort handle is an accelerator. `failStart` records the failed request durably and `launchDraft` re-reads that row immediately before it activates the mission, so a cancelled launch cannot come active even when the registry is lost or raced (probe below)"],
  ["src/runtime.ts",10,"Map","readonly startFailures = new Map<string, number>()","gate","derivable","S5c: the count is read from and written to the durable member row (`startFailures` field) and cleared there by the same successful start that clears the provider outage; the Map is the in-process mirror, so a lost map or a restart continues the count instead of resetting the route budget (probe below)"],
  ["src/runtime.ts",11,"Map","private readonly observeCursors = new Map<string, DeliveredCursor>()","gate","cache-only","delivered-position context cache; loss re-sends one bounded focused view and a cursor can never exceed the durable log"],
  ["src/runtime.ts",12,"Map","private readonly autoReviewAdmissions = new Map<string, string>()","gate","derivable","the durable task/review-admitted event is read first; the map is only a fallback for an admission whose event write failed"],
  ["src/runtime.ts",13,"Set","private readonly reviewPathReported = new Set<string>()","gate","derivable","the durable task/review-missing event for the exact submission is re-read before the set is trusted"],
  ["src/runtime.ts",14,"Set","const seen = new Set<string>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",15,"Set","const seen = new Set<string>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",16,"Set","dependencyIdentities(missionId: string, dependencyId: string, tasks?: Task[]): Set<string> { return new Set(this.lineage(missionId, dependencyId, tasks).map(task => task.id)) }","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",17,"Set","const seen = new Set<string>([task.id])","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",18,"Map","const byId = new Map(tasks.map(task => [task.id, task]))","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",19,"Map","const chains = new Map<string, string[]>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",20,"Set","const candidate = visit(task.id, new Set())","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",21,"Set","const member: Member = { id: memberId, missionId, name: input.name, role: input.role, model: input.model, provider: input.provider, reasoningEffort: input.reasoningEffort, maxOutputTokens: input.maxOutputTokens, sessionId: id('swarm-session'), workspace, status: 'idle', subscriptions: input.subscriptions === undefined ? [] : [...new Set(input.subscriptions)] }","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",22,"Set","knownContents: new Set(this.store.list('tasks', missionId).map(task => task.id)),","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",23,"Set","const dependencies = [...new Set(normalizeReviewDependencies(input.kind, input.reviewOf, input.dependencies))]","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",24,"Set","if (input.replaces?.length) task.replaces = [...new Set(input.replaces)]","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",25,"Set","const ids = new Set(task.priorOwnerIds ?? [])","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",26,"Set","const released = new Set<string>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",27,"Set","if (this.workers.compactAtBoundary) for (const memberId of new Set([source.attempt?.ownerId, member.id])) if (memberId) this.workers.compactAtBoundary(memberId)","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",28,"Set","const interrupted = new Set<string>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",29,"Set","const invalidated = new Set([source.id])","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",30,"Set","const released = new Set<string>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",31,"Set","const live = new Set(this.store.list('members', missionId).filter(member => member.status !== 'stopped').map(member => member.id))","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",32,"Set","const released = new Set<string>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",33,"Set","member.subscriptions = [...new Set(topics)]","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",34,"Map","const byKey = new Map(plan.tasks.map(task => [task.key, task]))","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",35,"Set","const pending = [...(byKey.get(key)?.dependencies ?? [])], visited = new Set<string>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",36,"Set","const memberMissions = new Set(this.store.list('members').filter(m => m.sessionId === actor.sessionId && m.status !== 'stopped').map(m => m.missionId))","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",37,"Set","const leftover = options.cancelUnschedulable ? new Set(this.unschedulable(mission, tasks, this.store.list('members', mission.id)).map(task => task.id)) : new Set<string>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/runtime.ts",38,"Set","const dead = new Set(tasks.filter(task => task.status === 'cancelled' || leftover.has(task.id)).map(task => task.id))","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/scheduling.ts",1,"Set","readonly releasedPasses = new Set<string>()","gate","derivable","S5c: the watchdog stamps `releasedRunId` on the durable passes row before releasing, and `openPass`/`closePass` carry it forward across the once-per-pass overwrite; `passReleased` reads that row first, so clearing the Set cannot let a released body resume and dispatch (probe below)"],
  ["src/scheduling.ts",2,"Set","const dead = new Set(tasks.filter(task => task.status === 'blocked' && !this.quiescencePending(task)).map(task => task.id))","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/scheduling.ts",3,"Set","const covers = (task: Task, sourceId: string, seen = new Set<string>()): boolean => {","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/store.ts",1,"Set","private readonly listeners = new Set<() => void>()","gate","cache-only","observer fan-out for committed changes; the durable revision and change cursor carry the state"],
  ["src/store.ts",2,"Set","this.transactionScopes = new Set()","transient","","created and destroyed inside one store transaction; the revision-bump decision it feeds is re-derived on every call"],
  ["src/trace.ts",1,"Map","private readonly indexes = new Map<string, SpanIndex>()","outside","","outside the runtime decision path: the trace read model (TraceIndex): an owner-UI projection cache no runtime decision reads (enumerated, no label claimed)"],
  ["src/trace.ts",2,"Map","private readonly unscoped = new Map<string, number>()","outside","","outside the runtime decision path: the trace read model (TraceIndex): an owner-UI projection cache no runtime decision reads (enumerated, no label claimed)"],
  ["src/trace.ts",3,"Map","const index: SpanIndex = { byTask: new Map(), byAttempt: new Map(), all: [] }","outside","","outside the runtime decision path: the trace read model (TraceIndex): an owner-UI projection cache no runtime decision reads (enumerated, no label claimed)"],
  ["src/trace.ts",4,"Set","const known = new Set(spans.map(span => span?.spanId))","outside","","outside the runtime decision path: the trace read model (TraceIndex): an owner-UI projection cache no runtime decision reads (enumerated, no label claimed)"],
  ["src/trace.ts",5,"Map","const counts = new Map<string, number>()","outside","","outside the runtime decision path: the trace read model (TraceIndex): an owner-UI projection cache no runtime decision reads (enumerated, no label claimed)"],
  ["src/trace.ts",6,"Map","const tasks = new Map<string, string>(), members = new Map<string, string>()","outside","","outside the runtime decision path: the trace read model (TraceIndex): an owner-UI projection cache no runtime decision reads (enumerated, no label claimed)"],
  ["src/trace.ts",7,"Set","const ATTEMPT_CLOSERS = new Set(['task/submitted', 'task/blocked', 'task/cancelled', 'task/cancelled-at-completion', 'task/lease-expired', 'task/handoff-started', 'task/invalidated', 'task/review-retired', 'task/closeout-abandoned', 'task/closeout-failed', 'task/accepted', 'task/rejected'])","constant","","module-level immutable lookup table, never mutated after construction: data, not a gate"],
  ["src/trace.ts",8,"Map","const open = new Map<string, { taskId: string; memberId: string }>()","outside","","outside the runtime decision path: the trace read model (TraceIndex): an owner-UI projection cache no runtime decision reads (enumerated, no label claimed)"],
  ["src/web-api.ts",1,"Set","const providers = new Set(ctx.llm.listProviders().map(provider => provider.id))","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/web-api.ts",2,"Set","const visibleScopes = () => new Set([sessionId, ...runtime.visibleMissions(actor).map(mission => mission.id)])","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/web-api.ts",3,"Set","const changed = new Set(changes.flatMap(change => change.scopes).filter(scope => allowed.has(scope)))","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/workspace-admission.ts",1,"Set","const SHARED_TEMP_ROOTS: readonly string[] = [...new Set(['/tmp', '/var/tmp', tmpdir()].flatMap(root => {","constant","","module-level immutable lookup table, never mutated after construction: data, not a gate"],
  ["src/workspace-admission.ts",2,"Map","const SHELL_COMMAND_KEYS = new Map<string, readonly string[]>([","constant","","module-level immutable lookup table, never mutated after construction: data, not a gate"],
  ["src/workspace-admission.ts",3,"Set","const GIT_OPTION_ARGUMENTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--exec-path', '--namespace', '--config-env'])","constant","","module-level immutable lookup table, never mutated after construction: data, not a gate"],
  ["src/workspace-admission.ts",4,"Set","const COMMAND_WRAPPERS = new Set(['env', 'command', 'sudo', 'nohup', 'time', 'exec', 'nice', 'doas', 'builtin'])","constant","","module-level immutable lookup table, never mutated after construction: data, not a gate"],
  ["src/workspace-admission.ts",5,"Set","const WRAPPER_OPTION_ARGUMENTS = new Set(['-u', '-g', '-p', '-C', '-h', '-U', '-r', '-t', '-D', '-n', '-f', '-o', '-a', '--user', '--group', '--prompt', '--host', '--other-user', '--role', '--type', '--close-from', '--chdir', '--unset', '--format', '--output', '--adjustment'])","constant","","module-level immutable lookup table, never mutated after construction: data, not a gate"],
  ["src/workspace-admission.ts",6,"Map","private readonly tempMentions = new Map<string, TempMention[]>()","gate","cache-only","bounded advisory mention window; loss re-arms the warning and decides no durable outcome"],
  ["src/workspace-admission.ts",7,"Map","private readonly tempRendezvousReported = new Map<string, number>()","gate","cache-only","advisory rendezvous dedup window; loss re-reports the advisory warning and no durable outcome changes"],
  ["src/workspace-admission.ts",8,"Map","const byWorkspace = new Map<string, Member[]>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/workspace-admission.ts",9,"Map","const byTaskWorkspace = new Map<string, Task[]>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/workspaces.ts",1,"Map","private readonly summary = new Map<string, string>()","local","","per-run scanner instance (`new CheckOutputScanner()` for each declared check): the map is discarded with the run, so it cannot gate a later call"],
  ["src/workspaces.ts",2,"Map","const worktreeQueues = new Map<string, Promise<void>>()","outside","","outside the runtime decision path: the workspace engine (Workspaces); note that worktreeQueues is a process-global promise chain with the same presence-swallows shape as SwarmRuntime.queues (hand-off) (enumerated, no label claimed)"],
  ["src/workspaces.ts",3,"Map","private readonly controllers = new Map<string, Set<AbortController>>()","outside","","outside the runtime decision path: the workspace engine (Workspaces); note that worktreeQueues is a process-global promise chain with the same presence-swallows shape as SwarmRuntime.queues (hand-off) (enumerated, no label claimed)"],
  ["src/workspaces.ts",4,"Set","private readonly inFlight = new Set<Promise<unknown>>()","outside","","outside the runtime decision path: the workspace engine (Workspaces); note that worktreeQueues is a process-global promise chain with the same presence-swallows shape as SwarmRuntime.queues (hand-off) (enumerated, no label claimed)"],
  ["src/workspaces.ts",5,"Map","private readonly baselines = new Map<string, Promise<WorkspaceBaseline>>()","outside","","outside the runtime decision path: the workspace engine (Workspaces); note that worktreeQueues is a process-global promise chain with the same presence-swallows shape as SwarmRuntime.queues (hand-off) (enumerated, no label claimed)"],
  ["src/workspaces.ts",6,"Map","private readonly commonDirs = new Map<string, Promise<string>>()","outside","","outside the runtime decision path: the workspace engine (Workspaces); note that worktreeQueues is a process-global promise chain with the same presence-swallows shape as SwarmRuntime.queues (hand-off) (enumerated, no label claimed)"],
  ["src/workspaces.ts",7,"Map","private readonly artifactRepos = new Map<string, Promise<string>>()","outside","","outside the runtime decision path: the workspace engine (Workspaces); note that worktreeQueues is a process-global promise chain with the same presence-swallows shape as SwarmRuntime.queues (hand-off) (enumerated, no label claimed)"],
  ["src/workspaces.ts",8,"Set","const active = this.controllers.get(memberId) ?? new Set<AbortController>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/workspaces.ts",9,"Set","return new Set(this.options.verificationDependencyDirs ?? DEFAULT_VERIFICATION_DEPENDENCY_DIRS)","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/workspaces.ts",10,"Set","const candidates = new Set<string>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/workspaces.ts",11,"Set","const links = new Set<string>()","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/workspaces.ts",12,"Set","const changed = new Set((await this.git(member.workspace, ['diff', '--name-only', '--no-renames', '-z', baseCommit, '--'], signal, undefined, INVENTORY_BYTES)).split('\\0').filter(Boolean).filter(name => !dependencyContent(name)))","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
  ["src/workspaces.ts",13,"Set","const names = new Set(this.options.verificationDependencyDirs ?? DEFAULT_VERIFICATION_DEPENDENCY_DIRS)","local","","function-local: created and discarded inside one synchronous call, so it cannot gate a later call"],
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
      'Classify it in CENSUS: a gate needs a label (derivable | cache-only) and a test body in GATE_TESTS; a transient, constant or out-of-unit collection needs that class and a reason.')
    assert.equal(entry[2], kind, `${id} changed constructor from ${entry[2]} to ${kind}; re-classify it`)
    assert.equal(entry[3], source, `${id} changed text; if it is still the same collection, update CENSUS, otherwise classify the new one`)
    seen.add(id)
  }
  for (const entry of CENSUS) assert.ok(seen.has(key(entry)), `stale census entry ${key(entry)} is no longer in the tree`)
  const counts = CENSUS.reduce((all, entry) => ({ ...all, [entry[4]]: (all[entry[4]] ?? 0) + 1 }), {})
  assert.equal(counts.gate, GATES.length)
  // S5c: zero unlabelled behaviour-gating entries, asserted BY NAME for the five
  // that used to carry the third state, not by a count that could be edited.
  const CLOSED = {
    'src/runtime.ts:7': 'cache-only',
    'src/runtime.ts:8': 'cache-only',
    'src/runtime.ts:9': 'derivable',
    'src/runtime.ts:10': 'derivable',
    'src/scheduling.ts:1': 'derivable',
  }
  for (const label of new Set(GATES.map(entry => entry[5]))) {
    assert.ok(label === 'derivable' || label === 'cache-only',
      `gate ${key(GATES.find(entry => entry[5] === label))} carries ${JSON.stringify(label)}; every gate must be derivable or cache-only`)
  }
  for (const [entryKey, label] of Object.entries(CLOSED)) {
    const entry = GATES.find(candidate => key(candidate) === entryKey)
    assert.ok(entry !== undefined, `${entryKey} must still be a labelled gate entry`)
    assert.equal(entry[5], label, `${entryKey} must be ${label}: S5c closed the gate that used to be reported as neither`)
  }
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
  'src/runtime.ts:6': async t => {
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
  'src/runtime.ts:7': async t => {
    const f = await setup({ config: { tickMs: 10, stallPassTimeoutMs: 50 } })
    try {
      // Live work plus a wedged queued body: before S5c the next mission
      // operation chained behind the promise that never settles and was
      // swallowed (the Row-13 shape). The assertion is deliberately inverted
      // from the predecessor's probe, so a regression to a swallowing chain
      // fails this test.
      const task = f.propose({ title: 'Live work under a wedged queue' })
      await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
      void f.runtime.exclusive(f.mission.id, () => new Promise(() => {}))
      assert.ok(f.runtime.queues.size > 0, 'the wedged body holds a chain entry')
      const ran = await Promise.race([
        f.runtime.exclusive(f.mission.id, async () => 'ran'),
        new Promise(resolve => setTimeout(() => resolve('SWALLOWED'), 1_000)),
      ])
      assert.equal(ran, 'ran', 'a predecessor wedged past the declared bound must not swallow the next mission operation')

      // The loss on a non-empty collection: clearing the ordering cache removes
      // serialization only. The gated body still runs and its durable write
      // still lands, and the mission's durable attempt is untouched.
      const gate = deferred()
      const pending = f.runtime.exclusive(f.mission.id, async () => {
        await gate.promise
        const mission = f.runtime.mission(f.mission.id)
        mission.updatedAt += 1
        f.runtime.commit(f.mission.id, () => f.runtime.store.put('missions', mission))
        return 'gated'
      })
      assert.ok(f.runtime.queues.size > 0, 'the loss must be exercised on a non-empty collection')
      const revision = f.runtime.store.revision()
      f.runtime.queues.clear()   // the loss
      gate.resolve()
      assert.equal(await pending, 'gated', 'clearing the ordering cache does not cancel the body it was ordering')
      assert.ok(f.runtime.store.revision() > revision, 'the gated body still committed its durable write')
      assert.equal(taskOf(f.runtime, task.id).status, 'running', 'the durable attempt is untouched by the lost ordering cache')
      const rejected = await f.runtime.exclusive(f.mission.id, () => { throw new Error('probe rejection') }).then(() => 'resolved', error => `rejected:${error.message}`)
      assert.equal(rejected, 'rejected:probe rejection', 'a rejected body does not swallow the chain')
    } finally { await f.cleanup() }
  },
  'src/runtime.ts:8': async t => {
    // The loss on a non-empty collection: clear the drain registry while a
    // deferred body is in flight. The body is registered by `defer` and runs
    // regardless, so its durable write still lands — the registry orders
    // shutdown, it does not gate the work.
    const f = await setup()
    try {
      const stamp = f.runtime.mission(f.mission.id).updatedAt
      const gate = deferred()
      f.runtime.defer(async () => {
        await gate.promise
        const mission = f.runtime.mission(f.mission.id)
        mission.updatedAt = stamp + 5
        f.runtime.commit(f.mission.id, () => f.runtime.store.put('missions', mission))
      })
      assert.ok(f.runtime.operations.size > 0, 'the loss must be exercised on a non-empty collection')
      f.runtime.operations.clear()   // the loss
      gate.resolve()
      await eventually(() => f.runtime.mission(f.mission.id).updatedAt === stamp + 5 ? true : undefined,
        'the deferred durable write still lands after the drain registry is cleared')
      // Every deferred body the runtime schedules re-derives its work from
      // durable state (the pass row, the budget stop claim, the outbox), so a
      // lost drain cannot make a durable transition wrong. The queued owner
      // notice below is the durable record a later pump delivers from.
      await f.runtime.commit(f.mission.id, () => f.runtime.notify(f.mission.id, 'S5c drain probe', [`mission:${f.mission.id}`], { from: 'runtime', noticeClass: 'decision', dedupe: false }))
      const queued = f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner' && delivery.deliveredAt === undefined)
      assert.ok(queued.length >= 1, 'the deferred notice is durable in the outbox, so a later pump re-derives it')
    } finally { await f.cleanup() }
  },
  'src/runtime.ts:9': async t => {
    const workers = new GatedWorkers()
    const f = await setup({ workers })
    try {
      const request = f.runtime.requestStart(f.owner, { commandId: 's5c-cancel', goal: 'Make the requested change and verify it', workspace: f.dir })
      const gate = deferred()
      workers.prepareGate = gate.promise
      const launching = f.runtime.startPlan(f.owner, request.id, automaticPlan(f.dir))
      await eventually(() => workers.prepareStarted > 0 ? true : undefined, 'the launch must be in flight (workspace preparation started)')
      // The cancellation is recorded durably, and the in-memory abort registry is
      // lost on purpose: the launch must still not come active, because the
      // decision is re-read from the durable start row before activation.
      assert.ok(f.runtime.startControllers.size > 0, 'the in-flight launch holds an abort handle')
      f.runtime.startControllers.clear()   // the loss
      f.runtime.failStart(f.owner, request.id, 'S5c: cancel the in-flight launch')
      assert.equal(f.runtime.store.get('starts', request.id).status, 'failed', 'the cancellation is durable')
      gate.resolve()
      await assert.rejects(launching, /Plan assembly was interrupted/,
        'the launch honours the durable cancellation instead of the lost abort handle')
      assert.equal(f.runtime.store.get('starts', request.id).status, 'failed', 'the request stays failed')
      // The cancellation is attributable from the durable record: `failStart`
      // wrote this event with the reason before the launch noticed. The event is
      // recorded under the launch's mission id (the request names it already).
      const cancelledMissionId = f.runtime.store.get('starts', request.id).missionId
      const cancelEvent = events(f.runtime, cancelledMissionId, 'automatic/failed')
        .find(event => /cancel the in-flight launch/.test(String(event.data.reason)))
      assert.ok(cancelEvent !== undefined, 'the durable failure event names the cancellation reason')
      const cancelledMission = cancelledMissionId === undefined ? undefined : f.runtime.store.get('missions', cancelledMissionId)
      assert.ok(cancelledMission === undefined || cancelledMission.status !== 'active',
        'a cancelled launch never brings its own mission active')
    } finally { await f.cleanup() }
  },
  'src/runtime.ts:10': async t => {
    const f = await setup()
    try {
      f.propose({ title: 'Failing route' })
      f.runtime.onStartFailure(f.mission, f.author, new Error('injected start failure'))
      f.runtime.onStartFailure(f.mission, f.author, new Error('injected start failure'))
      assert.equal(f.runtime.startFailures.get(f.author.id), 2, 'the mirror holds the count')
      assert.equal(f.runtime.store.get('members', f.author.id).startFailures, 2, 'the durable member row holds the same count')
      assert.ok(f.runtime.startFailures.size > 0, 'the loss must be exercised on a non-empty collection')
      f.runtime.startFailures.clear()   // the loss
      f.runtime.onStartFailure(f.mission, f.author, new Error('injected start failure'))
      assert.equal(f.runtime.store.get('members', f.author.id).status, 'stopped',
        'the third consecutive failure still retires the member: the gate reads the durable count, not the lost map')
      assert.equal(f.runtime.store.get('members', f.author.id).startFailures, 3, 'the durable count continues')
      assert.deepEqual(events(f.runtime, f.mission.id, 'task/start-failed').map(event => event.data.consecutiveFailures), [1, 2, 3],
        'the durable log agrees with the durable count')
    } finally { await f.cleanup() }
    // A restart continues the count instead of handing the failing route a fresh budget.
    const g = await setup()
    let restarted
    try {
      g.runtime.onStartFailure(g.mission, g.author, new Error('injected start failure'))
      g.runtime.onStartFailure(g.mission, g.author, new Error('injected start failure'))
      const statePath = join(g.dir, 'swarm.sqlite')
      await g.runtime.dispose()
      restarted = new SwarmRuntime({ statePath, leaseMs: 60000, tickMs: 10, messageChars: 16000, maxMessageChars: 16000, maxEvents: 500, maxTasksPerMember: 3 }, new FakeWorkers())
      assert.equal(restarted.store.get('members', g.author.id).startFailures, 2, 'the count survives a restart')
      restarted.onStartFailure(restarted.mission(g.mission.id), restarted.store.get('members', g.author.id), new Error('injected start failure'))
      assert.equal(restarted.store.get('members', g.author.id).status, 'stopped', 'and the restarted runtime retires on the third failure')
    } finally { if (restarted !== undefined) await restarted.dispose(); await g.cleanup() }
  },
  'src/runtime.ts:11': async t => {
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
  'src/runtime.ts:12': async t => {
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
  'src/runtime.ts:13': async t => {
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
  'src/notices.ts:2': async t => {
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
  'src/notices.ts:3': async t => {
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
  'src/notices.ts:4': async t => {
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
  'src/notices.ts:5': async t => {
    const f = await setup({ config: { tickMs: 10, stallPassTimeoutMs: 100 } })
    try {
      const first = f.propose({ title: 'Notice' })
      await f.runtime.commit(f.mission.id, () => f.runtime.notify(f.mission.id, 'S5 outbox probe', [`mission:${f.mission.id}`], { from: 'runtime', noticeClass: 'decision', dedupe: false }))
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
      // THE VERIFIER'S REPRODUCTION, closed: the in-memory Set is cleared while
      // the durable `releasedRunId` on the pass row is present. The watchdog
      // stamps that field before releasing, so the fence must survive.
      f.runtime.releasedPasses.clear()
      f.runtime.store.transaction(() => f.runtime.store.put('passes', { ...abandonedPass, status: 'finished', releasedRunId: abandonedPass.runId, releasedAt: Date.now() }))
      assert.equal(await f.runtime.scheduling.dispatch(f.mission, f.mission.id, abandonedPass), false,
        'with the Set cleared but the durable release present, the abandoned pass body still dispatches nothing')
      assert.equal(taskOf(f.runtime, task.id).status, 'pending', 'and it still cannot drive a task to running')
      // Positive control: a pass that was never released is not fenced (the fence
      // is the durable release record, not a blanket refusal).
      const live = { ...abandonedPass, runId: 'never-released-run' }
      f.runtime.store.transaction(() => f.runtime.store.put('passes', { ...live, status: 'running' }))
      assert.equal(await f.runtime.scheduling.dispatch(f.mission, f.mission.id, live), true, 'a live pass body still dispatches')
      assert.equal(taskOf(f.runtime, task.id).status, 'running', 'and assigns the work normally')
      assert.ok(taskOf(f.runtime, task.id).attempt?.leaseUntil > Date.now(), 'with a real attempt')
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

test('S5c D1 closed: the stale-revision refusal event is registered and visible to the vocabulary check', async () => {
  // The refusal type is emitted through the exported constant
  // `STALE_TASK_REFUSAL_EVENT`. S5r pinned the resulting gap (the static emitter
  // scan could not see it, and `eventVocabularyReport` reported the durable row
  // as unrecognized — verifier-1's reproduction). S5c closes it at the choke
  // point: `src/trace.ts` registers the row and the scanner in
  // tests/event-vocabulary.test.mjs resolves exported constants, so the type is
  // enforced exactly like a literal emission.
  const { EVENT_VOCABULARY } = await import('../lib/trace.js')
  const { STALE_TASK_REFUSAL_EVENT } = await import('../lib/store.js')
  assert.equal(STALE_TASK_REFUSAL_EVENT, 'task/stale-revision-refused')
  assert.equal(typeof EVENT_VOCABULARY[STALE_TASK_REFUSAL_EVENT], 'string',
    'the vocabulary must name task/stale-revision-refused (the D1 gap is closed)')
})

test('S5 inventory: every gate entry has exactly one test', () => {
  for (const entry of GATES) assert.equal(typeof GATE_TESTS[key(entry)], 'function', `${key(entry)} is labelled a gate, so it needs a test body`)
  for (const entry of Object.keys(GATE_TESTS)) assert.ok(GATES.some(candidate => key(candidate) === entry), `${entry} has a test but is not a labelled gate entry`)
})

for (const [entryKey, body] of Object.entries(GATE_TESTS)) {
  const entry = CENSUS.find(candidate => key(candidate) === entryKey)
  test(`S5 gate ${entryKey} [${entry[5]}] — ${entry[0].replace('src/', '')}`, body)
}
