/**
 * The full-log oracle's recording and normalization (scripts/replay/oracle.mjs
 * runs it). A refactor of the runtime changes no behaviour exactly when every
 * oracle run produces the same log as the base build did:
 *
 *  - every durable event (all missions, in `seq` order) and every row of every
 *    store table, which includes every delivery (the ledger that the owner was
 *    told) and every mission row;
 *  - the adapter call trace: each call the runtime makes into its
 *    `WorkerAdapter`, in order, with its arguments reduced to identities, and
 *    the answer of every synchronous query (`isIdle`, `currentActivity`, ...).
 *
 * The runs use a FakeClock at a fixed epoch with `manualTick` and counter ids
 * (`deterministicIds`), so everything the runtime decides is the same on every
 * run and the log keeps it as decided: an instant on the runtime clock as its
 * offset from ORACLE_EPOCH (`t+60000`), a rendered span (`2m 0s`), and every
 * digest of deterministic text (a dedup key's, a notice key's) verbatim. Ids
 * become ordinal labels by first appearance (`task#3`), which keeps every
 * equality between them. Normalization masks only what the host contributes
 * (`normalizer`), never a decision.
 */
import { createHash } from 'node:crypto'
import { createRequire, syncBuiltinESMExports } from 'node:module'

/** The fixed instant every oracle clock starts from. */
export const ORACLE_EPOCH = 1_700_000_000_000

/**
 * Replace `crypto.randomUUID` for this whole process (the runtime's ESM
 * imports see it through `syncBuiltinESMExports`) with a counter, so ids, and
 * every order that ties on them, are the same on every run.
 */
export function deterministicIds() {
  const crypto = createRequire(import.meta.url)('node:crypto')
  let counter = 0
  crypto.randomUUID = () => `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, '0')}`
  syncBuiltinESMExports()
}

/** An argument reduced to its identity: a row is its id (with its epoch), a signal or callback is its kind. */
function identity(value, depth = 0) {
  if (typeof value === 'function') return '<fn>'
  if (value === null || typeof value !== 'object') return value
  if (typeof AbortSignal !== 'undefined' && value instanceof AbortSignal) return '<signal>'
  if (Array.isArray(value)) return value.map(item => identity(item, depth + 1))
  if (typeof value.id === 'string') return value.epoch === undefined ? value.id : `${value.id}@${value.epoch}`
  if (depth > 0) return '<object>'
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, identity(item, depth + 1)]))
}

/**
 * The adapter the runtime is handed, recording every call it makes in `calls`.
 * Methods are read from `workers` at call time, so a scenario that replaces one
 * on the instance is still recorded; an absent optional method stays absent.
 * A synchronous answer is recorded with the call; a promise is not awaited.
 */
export function traceAdapter(workers, calls = []) {
  const adapter = new Proxy(workers, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function' || typeof property !== 'string' || property === 'constructor') return value
      return function traced(...args) {
        const entry = [property, ...args.map(arg => identity(arg))]
        calls.push(entry)
        const result = value.apply(target, args)
        if (!(result instanceof Promise) && property !== 'bind') entry.push({ returned: identity(result) })
        return result
      }
    },
  })
  return { adapter, calls }
}

/**
 * The moment this process started. The oracle clock starts at ORACLE_EPOCH,
 * years earlier, and no scenario moves it to the present, so an instant at or
 * after this one was read from the host's wall clock, not the runtime clock.
 */
const HOST_NOW = Date.now()
/** Spans the runtime measures on the host's clocks (an admission's latency, a tool call's duration, a git lock wait). */
const HOST_SPAN = /^(latencyMs|durationMs|waitMs)$/

const ID = /\b([a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)*)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/g
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g
/** A git object id: git stamps every commit with the host's time. */
const GIT_OBJECT = /\b[0-9a-f]{40}\b/g
/** An epoch instant in milliseconds, wherever text renders one. */
const INSTANT = /\b1[0-9]{12}\b/g

/**
 * One normalizer per log. It masks exactly what the host contributes to a run:
 *  - the run's temp directories (`<dir>`);
 *  - an instant read from the host's wall clock (`<host-t>`, see HOST_NOW: a
 *    tool span's bounds, a git snapshot's `createdAt`), and a span measured on
 *    the host's clocks (`<host-span>`, HOST_SPAN);
 *  - a git object id, labeled `git#n` by first appearance;
 *  - a trace span payload's `digest` (`input`/`output`), labeled `digest#n`: it
 *    hashes tool arguments and results that carry the run's temp paths.
 * Ids are labeled `<prefix>#n` by first appearance. Everything else is kept as
 * decided, an instant on the runtime clock as its offset from ORACLE_EPOCH.
 */
export function normalizer(directories = []) {
  const labels = new Map(), counts = new Map()
  const label = (raw, prefix) => {
    let value = labels.get(raw)
    if (value === undefined) {
      const count = (counts.get(prefix) ?? 0) + 1
      counts.set(prefix, count)
      value = `${prefix}#${count}`
      labels.set(raw, value)
    }
    return value
  }
  const roots = [...new Set(directories.filter(Boolean))].sort((a, b) => b.length - a.length)
  const instant = at => at >= HOST_NOW ? '<host-t>' : `t${at < ORACLE_EPOCH ? '-' : '+'}${Math.abs(at - ORACLE_EPOCH)}`
  const text = value => {
    let result = value
    for (const root of roots) result = result.split(root).join('<dir>')
    return result
      .replace(ID, (raw, prefix) => label(raw, prefix))
      .replace(UUID, raw => label(raw, 'uuid'))
      .replace(GIT_OBJECT, raw => label(raw, 'git'))
      .replace(INSTANT, raw => instant(Number(raw)))
  }
  const normalize = (value, parent) => {
    if (typeof value === 'string') return text(value)
    if (value === null || typeof value !== 'object') return typeof value === 'number' && value >= 1e12 ? instant(value) : value
    if (Array.isArray(value)) return value.map(item => normalize(item))
    const result = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue
      result[text(key)] = HOST_SPAN.test(key) ? '<host-span>'
        : key === 'digest' && (parent === 'input' || parent === 'output') ? label(value[key], 'digest')
          : normalize(value[key], key)
    }
    return result
  }
  return value => normalize(value)
}

/** The store tables the log dumps, every row of each in insertion order. */
const TABLES = ['missions', 'members', 'workstreams', 'tasks', 'evidence', 'tool_runs', 'deliveries', 'drafts', 'starts', 'admissions', 'limits']

/**
 * The normalized full log of one runtime: every event of every mission and of
 * the install pseudo-mission, every row of every table, and the adapter trace.
 * Read before the runtime is disposed.
 */
export function oracleLog(runtime, calls, directories = []) {
  const normalize = normalizer(directories)
  const missions = runtime.store.list('missions').map(mission => mission.id)
  const events = ['swarm/install', ...missions].flatMap(missionId => runtime.store.events(missionId, Number.MAX_SAFE_INTEGER))
    .sort((a, b) => a.seq - b.seq)
    .map(event => normalize({ missionId: event.missionId, type: event.type, actor: event.actor, data: event.data }))
  const tables = Object.fromEntries(TABLES.map(table => [table, runtime.store.list(table).map(normalize)]))
  return { events, tables, trace: calls.map(normalize) }
}

/** The digest a golden records for one log. */
export const logDigest = log => `sha256:${createHash('sha256').update(JSON.stringify(log)).digest('hex')}`
