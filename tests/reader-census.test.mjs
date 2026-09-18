/**
 * Round 15, Pass 2 — the reader census, as a repository fact.
 *
 * WHAT THIS FILE IS. The census is not a note: it is these tables plus the
 * checks below. Every tool in `SWARM_TOOLS` (the registry that defines the
 * model-facing surface) and every examined payload field must carry a recorded
 * decision, a named reader role, a proof that exists in the tree, and the job
 * that reader performs. A later addition that has no reader or no decision fails
 * this file instead of passing unnoticed.
 *
 * WHAT COUNTS AS A READER. A worker or owner decision, dispatch, recovery,
 * acceptance, the UI projection, human understanding, audit, replay, or
 * historical compatibility. A human-facing projection that enables a concrete
 * action or understanding counts even when it displays rather than decides — it
 * is recorded as role `ui`. A vocabulary description alone is not proof of
 * value, and a `test`-only row is rejected.
 *
 * EVENTS ARE NO LONGER A TABLE HERE. The per-kind event rows were a hand-kept
 * mirror of `src/events.ts`: every kind now carries its description and its
 * panel decision (a label, or the reason the panel omits it) beside its key, and
 * `EventKind` makes an unregistered kind a compile error. What a type cannot
 * prove is that a registered kind is ever written, so exactly one check remains:
 * every kind without `historical: true` has a writer in `src/`.
 *
 * THE DELETION RULE. Only proven duplication or unused surface is deleted: a
 * deleted kind must be absent from the registry, absent from every source, test,
 * script and doc outside this file, and an old log row that carries it must
 * still replay with its data intact. The live sibling keeps its writer and its
 * panel label, which is what makes the absence meaningful rather than a rename.
 *
 * COUNTS ON THIS ARTIFACT (measured, not quotas): 24 tools and 44 examined
 * payload fields. Nothing below was deleted to move a number.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SWARM_TOOLS } from '../lib/tools.js'
import { EVENT_VOCABULARY, eventVocabularyReport } from '../lib/trace.js'
import { EVENTS, EVENT_PANEL_LABELS } from '../lib/events.js'
import { SwarmStore } from '../lib/store.js'
import { tempDirectory } from './temp-root.mjs'
import { emittedEventTypes } from './source-semantics.mjs'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const CENSUS_FILE = 'tests/reader-census.test.mjs'

/** Roles a recorded reader may carry. `test` is deliberately absent: a test alone proves no value. */
const KEEP_ROLES = new Set(['engine', 'worker-decision', 'owner-decision', 'dispatch', 'recovery', 'acceptance', 'audit', 'ui', 'human', 'replay', 'compatibility'])

/*
 * TOOL CENSUS — one row per SWARM_TOOLS entry: [tool, decision, readerRole, proof, job].
 * A tool is a model-facing affordance: the reader is the worker or owner whose
 * decision uses it. The proof states exactly what proves the row, and there are
 * two kinds, checked by the tool-proof test below:
 *  - the test that exercises the tool's handler under `tests/` — 22 of 24 rows;
 *  - the handler module `src/tools.ts` for `swarm_challenge` and
 *    `swarm_subscribe`, whose model-visible surface is the golden fixture
 *    `tests/fixtures/model-visible.expected.json` (their worker tool set), read
 *    by `tests/harness-composition.mjs` and `tests/roles.test.mjs`.
 * The blanket claim that every row was proven by a test that exercises the tool
 * was false for those two rows (R16-G7); it now states the split, and the test
 * fails if either kind of proof stops holding.
 */
const TOOL_CENSUS = [
  ["swarm_stage", "keep", "worker-decision", "tests/authorized-workspace.test.mjs", "Save an editable mission plan for the Agent Swarm panel; creates no workers or model calls"],
  ["swarm_launch", "keep", "worker-decision", "tests/automatic.test.mjs", "Launch the complete plan for a native /agent-swarm request identified by requestId; no user confirmation is ne"],
  ["swarm_budget", "keep", "worker-decision", "tests/automatic.test.mjs", "Owner only: set all six resource ceilings from observed progress, with a reason"],
  ["swarm_create", "keep", "worker-decision", "tests/authorized-workspace.test.mjs", "Create a durable mission in the user-authorized workspace and scope with every budget field chosen for this ta"],
  ["swarm_add_member", "keep", "worker-decision", "tests/harness-composition.mjs", "Add a persistent worker sharing the mission budget; the runtime creates its isolated worktree. Omit `name` and the runtime assigns the next unused human name from the fixed pool; `role` carries the responsibility text and every address stays the member id."],
  ["swarm_workstream", "keep", "worker-decision", "tests/harness-composition.mjs", "Create a durable workstream in this mission; any member can propose work under it."],
  ["swarm_propose", "keep", "worker-decision", "tests/arena-protocols.test.mjs", "Propose and admit a task within mission scope and budget"],
  ["swarm_claim", "keep", "worker-decision", "tests/durability-w9-recovery.test.mjs", "Claim ready work as yourself; ownership is atomic and expires"],
  ["swarm_publish", "keep", "worker-decision", "tests/harness-composition.mjs", "Publish a finding backed by host run ids from this attempt (each tool result ends with its id)"],
  ["swarm_submit", "keep", "worker-decision", "tests/harness-composition.mjs", "Submit your current task and immutable artifact for independent verification"],
  ["swarm_verify", "keep", "worker-decision", "tests/harness-composition.mjs", "Independent verifier: run the source checks on its exact artifact and record accept or reject with a reason"],
  ["swarm_message", "keep", "worker-decision", "tests/harness-composition.mjs", "Send a question or finding to a member id or owner; topic broadcasts reach subscribers only"],
  ["swarm_challenge", "keep", "worker-decision", "src/tools.ts", "Challenge a finding with a reason and optional host-recorded counterevidence"],
  ["swarm_handoff", "keep", "worker-decision", "tests/guard-terminals.test.mjs", "Checkpoint work and release your attempt to another member or the ready queue; new ownership begins after you "],
  ["swarm_subscribe", "keep", "worker-decision", "src/tools.ts", "Replace your topic subscriptions (workstream ids; * for all findings)"],
  ["swarm_wait", "keep", "worker-decision", "tests/harness-workers.test.mjs", "Members only: park until relevant work or a direct message arrives, then end the turn"],
  ["swarm_observe", "keep", "worker-decision", "tests/harness-composition.mjs", "Bounded mission reads"],
  ["swarm_control", "keep", "worker-decision", "tests/harness-composition.mjs", "Owner: pause/resume/stop/complete the mission or replace its coordinator"],
  ["swarm_cancel", "keep", "worker-decision", "tests/owner-cancel.test.mjs", "Owner only: withdraw one admitted-but-mistaken task"],
  ["swarm_registry", "keep", "worker-decision", "tests/arena-visibility.test.mjs", "Owner only, read-only: the cross-mission artifact registry"],
  ["swarm_escalate", "keep", "worker-decision", "tests/arena-protocols.test.mjs", "Members only: typed durable owner escalation"],
  ["swarm_post", "keep", "worker-decision", "tests/board.test.mjs", "Sanctioned mission board: post one durable, immutable typed note (ASK/ANSWER/IDEA/ALERT/ARTIFACT/HANDOFF)"],
  ["swarm_board", "keep", "worker-decision", "tests/board.test.mjs", "Read the durable mission board as a bounded page (default 20, clamped to 100) plus the caller\\"],
  ["swarm_restore", "keep", "worker-decision", "tests/board.test.mjs", "Owner only: stage one validated mission-store snapshot for the next host start (R11-02)"],
]

/*
 * PAYLOAD CENSUS — the examined payloads and every field they carry:
 * [event, field, decision, readerRole, proof]. Bounded on purpose to the four
 * densest durable payloads (the stall family, the check envelope, the tool-run
 * audit row and the isolation rendezvous); a field that is dropped or renamed
 * must be visited here.
 */
const PAYLOAD_CENSUS = [
  ['mission/stalled', 'cause', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'passId', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'runId', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'reason', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'wedged', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'passStartedAt', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'boundMs', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'revisionBefore', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'revisionAtStall', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'missionFingerprint', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'ownerNotified', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'chain', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'code', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'taskId', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'memberId', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'detail', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'coFires', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'epoch', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'dependents', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'unschedulable', 'keep', 'engine', 'src/scheduling.ts'],
  ['task/check-envelope', 'taskId', 'keep', 'acceptance', 'src/declared-checks.ts'],
  ['task/check-envelope', 'sourceTaskId', 'keep', 'acceptance', 'src/declared-checks.ts'],
  ['task/check-envelope', 'verdict', 'keep', 'acceptance', 'src/declared-checks.ts'],
  ['task/check-envelope', 'reproduction', 'keep', 'acceptance', 'src/declared-checks.ts'],
  ['task/check-envelope', 'envelope', 'keep', 'acceptance', 'src/declared-checks.ts'],
  ['task/check-envelope', 'selfRun', 'keep', 'acceptance', 'src/declared-checks.ts'],
  ['task/check-envelope', 'selfRunSource', 'keep', 'acceptance', 'src/declared-checks.ts'],
  ['task/check-envelope', 'selfRunAt', 'keep', 'acceptance', 'src/declared-checks.ts'],
  ['task/check-envelope', 'blocking', 'keep', 'acceptance', 'src/declared-checks.ts'],
  ['task/check-envelope', 'advisory', 'keep', 'acceptance', 'src/declared-checks.ts'],
  ['tool/recorded', 'runId', 'keep', 'audit', 'src/runtime.ts'],
  ['tool/recorded', 'seq', 'keep', 'audit', 'src/runtime.ts'],
  ['tool/recorded', 'taskId', 'keep', 'audit', 'src/runtime.ts'],
  ['tool/recorded', 'tool', 'keep', 'audit', 'src/runtime.ts'],
  ['tool/recorded', 'isError', 'keep', 'audit', 'src/runtime.ts'],
  ['isolation/temp-rendezvous', 'path', 'keep', 'owner-decision', 'src/runtime.ts'],
  ['isolation/temp-rendezvous', 'firstMemberId', 'keep', 'owner-decision', 'src/runtime.ts'],
  ['isolation/temp-rendezvous', 'firstTaskId', 'keep', 'owner-decision', 'src/runtime.ts'],
  ['isolation/temp-rendezvous', 'firstAt', 'keep', 'owner-decision', 'src/runtime.ts'],
  ['isolation/temp-rendezvous', 'secondMemberId', 'keep', 'owner-decision', 'src/runtime.ts'],
  ['isolation/temp-rendezvous', 'secondTaskId', 'keep', 'owner-decision', 'src/runtime.ts'],
  ['isolation/temp-rendezvous', 'secondAt', 'keep', 'owner-decision', 'src/runtime.ts'],
  ['isolation/temp-rendezvous', 'windowMs', 'keep', 'owner-decision', 'src/runtime.ts'],
  ['isolation/temp-rendezvous', 'detection', 'keep', 'owner-decision', 'src/runtime.ts'],
]

/*
 * DELETED SURFACE — candidates whose decision is `delete`, with the proof that
 * nothing reads them. Each entry is also required to be absent from the
 * vocabulary and from every file outside this one.
 */
const DELETED_EVENT_KINDS = [
  ['mission/paused', 'exact duplicate of the live dynamic `mission/pause` family: identical description, no writer in this repository history, no reader anywhere'],
  ['mission/resumed', 'exact duplicate of the live dynamic `mission/resume` family: identical description, no writer in this repository history, no reader anywhere'],
  ['mission/stopped', 'unused surface: the live kind is the dynamic `mission/stop`; no writer ever emitted the `-ed` form and nothing reads it'],
  ['mission/completed', 'exact duplicate of the live dynamic `mission/complete` family: identical description, no writer in this repository history, no reader anywhere'],
]

function tree(...prefixes) {
  const found = []
  for (const prefix of prefixes) {
    const base = join(ROOT, prefix)
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue
      const path = join(entry.parentPath ?? entry.path ?? base, entry.name)
      if (/\.(ts|tsx|mjs|md|json|yml)$/.test(entry.name)) found.push(relative(ROOT, path))
    }
  }
  return found.sort()
}

const TREE = tree('src', 'tests', 'scripts')
const TEXT = new Map([...TREE, 'README.md', 'docs/known-limitations.md'].filter(existsSync).map(path => [path, readFileSync(join(ROOT, path), 'utf8')]))
const textOf = path => TEXT.get(path) ?? ''

/**
 * Which files write one kind: a literal second argument, a ternary pair
 * (`passed ? 'task/accepted' : 'task/rejected'`), a shared exported constant, or
 * the dynamic `mission/${action}` / `delivery/${result.status}` family token,
 * which is the one emission a type cannot name a literal for.
 */
const DYNAMIC_FAMILY = new Map([
  ['mission/pause', 'mission/${action}'], ['mission/resume', 'mission/${action}'], ['mission/stop', 'mission/${action}'],
  ['mission/complete', 'mission/${action}'], ['mission/coordinator', 'mission/${action}'],
  ['delivery/applied', 'delivery/${result.status}'], ['delivery/conflicts', 'delivery/${result.status}'],
])
const EMITTERS = (() => {
  const sources = TREE.filter(path => path.startsWith('src/'))
  const constants = new Map()
  for (const path of sources) for (const match of textOf(path).matchAll(/export const ([A-Za-z0-9_]+)\s*=\s*'([^']+)'/g)) constants.set(match[1], match[2])
  const map = new Map()
  const add = (kind, path) => { const list = map.get(kind) ?? []; if (!list.includes(path)) list.push(path); map.set(kind, list) }
  for (const path of sources) {
    for (const kind of emittedEventTypes(textOf(path), path, constants)) add(kind, path)
  }
  return map
})()

function writersOf(kind) {
  const token = DYNAMIC_FAMILY.get(kind)
  if (token !== undefined) return TREE.filter(path => path.startsWith('src/') && textOf(path).includes(token))
  return EMITTERS.get(kind) ?? []
}

test('event writer discovery follows nested conditional type branches without counting unrelated strings', () => {
  const source = "store.event(mission, handoff ? 'task/handoff-ready' : closeout ? (exhausted ? 'task/closeout-exhausted' : 'task/closeout-ready') : 'task/quiescence-recovered', 'runtime', { note: 'not-an-event' });"
  assert.deepEqual(emittedEventTypes(source).sort(), ['task/handoff-ready', 'task/closeout-exhausted', 'task/closeout-ready', 'task/quiescence-recovered'].sort())
})

/** Coverage: every registry entry has exactly one row and no row is stale. */
function coverage(registry, rows, label) {
  const recorded = new Set(rows.map(row => row[0]))
  const missing = registry.filter(key => !recorded.has(key))
  const stale = [...recorded].filter(key => !registry.includes(key))
  assert.deepEqual(missing, [], `${label}: ${missing.length} entr(y/ies) have no recorded decision: ${missing.join(', ')}`)
  assert.deepEqual(stale, [], `${label}: recorded decisions for entries that no longer exist: ${stale.join(', ')}`)
}

test('every registered event kind has a writer, so a kind cannot be registered and never emitted', () => {
  // `EventKind` proves a written kind is registered. The converse — a row that
  // exists only in the registry — is what this check owns, and `historical` is
  // the one recorded exception: the kind still decodes, nothing writes it.
  const historical = Object.entries(EVENTS).filter(([, spec]) => spec.historical === true).map(([kind]) => kind)
  assert.deepEqual(historical, ['task/cancelled-at-completion'], 'completion no longer withdraws leftover work; a new historical row needs its own reason here')
  const unwritten = Object.keys(EVENTS).filter(kind => !historical.includes(kind) && writersOf(kind).length === 0)
  assert.deepEqual(unwritten, [], `registered but never emitted: ${unwritten.join(', ')} — delete the row, or mark it historical: true`)
  for (const kind of historical) assert.deepEqual(writersOf(kind), [], `${kind}: marked historical, but a writer reappeared`)
  // Not vacuous: the derivation finds a real writer and invents none.
  assert.ok(writersOf('task/submitted').length > 0, 'the emitter derivation must see a live writer')
  assert.deepEqual(writersOf('mission/brand-new-unregistered-kind'), [], 'the derivation must not invent a writer')
})

test('every tool in SWARM_TOOLS has a recorded decision, a real reader and a job', () => {
  coverage([...SWARM_TOOLS], TOOL_CENSUS, 'tool census')
  const handlers = textOf('src/tools.ts')
  for (const [tool, decision, role, proof, job] of TOOL_CENSUS) {
    assert.equal(decision, 'keep', `${tool}: no tool was deleted this round`)
    assert.ok(KEEP_ROLES.has(role), `${tool}: unknown reader role ${role}`)
    assert.ok(typeof job === 'string' && job.length > 8, `${tool}: the job must be recorded`)
    assert.ok(handlers.includes(`'${tool}'`), `${tool}: no registration or handler in src/tools.ts`)
    assert.ok(existsSync(join(ROOT, proof)), `${tool}: proof ${proof} does not exist`)
    assert.ok(textOf(proof).includes(tool), `${tool}: proof ${proof} does not exercise it`)
  }
})

test('a tool row states exactly what proves it: an exercising test, or the handler plus the model-visible fixture', () => {
  const fixturePath = 'tests/fixtures/model-visible.expected.json'
  const fixture = textOf(fixturePath)
  assert.ok(fixture.length > 0, `${fixturePath}: the model-visible golden fixture must be readable`)
  for (const reader of ['tests/harness-composition.mjs', 'tests/roles.test.mjs']) {
    assert.ok(textOf(reader).includes('fixtures/model-visible.expected.json'), `${reader} must read the model-visible golden fixture`)
  }
  // The split the census documents: 22 rows carry an exercising test, and the
  // two handler-proofed rows are named. A third kind of proof, or a row that
  // moves from one kind to the other without the document changing, fails here.
  const handlerProofed = TOOL_CENSUS.filter(([, , , proof]) => proof === 'src/tools.ts').map(([tool]) => tool)
  assert.deepEqual(handlerProofed, ['swarm_challenge', 'swarm_subscribe'], 'the handler-proofed rows changed; docs/known-limitations.md states 22 of 24 tools are proven by a test that exercises the tool')
  assert.equal(TOOL_CENSUS.length - handlerProofed.length, 22, 'the exercising-test row count changed; docs/known-limitations.md states 22 of 24')
  const workerVisible = JSON.parse(fixture).workerSwarmTools
  for (const tool of handlerProofed) {
    assert.ok(workerVisible.includes(tool), `${tool}: the handler-proofed row must be covered by the model-visible worker tool set`)
  }
  for (const [tool, , , proof] of TOOL_CENSUS) {
    if (proof === 'src/tools.ts') continue
    assert.ok(proof.startsWith('tests/'), `${tool}: an exercising-test proof must live under tests/, got ${proof}`)
  }
})

test('every examined payload field is recorded, real, and names its reader', () => {
  const src = TREE.filter(path => path.startsWith('src/'))
  for (const [event, field, decision, role, proof] of PAYLOAD_CENSUS) {
    assert.ok(Object.hasOwn(EVENT_VOCABULARY, event), `${event}: payload of an unknown event kind`)
    assert.equal(decision, 'keep', `${event}.${field}: no payload field was deleted this round`)
    assert.ok(KEEP_ROLES.has(role), `${event}.${field}: unknown reader role ${role}`)
    assert.ok(existsSync(join(ROOT, proof)), `${event}.${field}: proof ${proof} does not exist`)
    const written = src.some(path => new RegExp(`\\b${field}\\s*:`).test(textOf(path)))
    assert.ok(written, `${event}.${field}: no writer carries this field`)
  }
  // The same field of the same event is recorded once per payload shape.
  const keys = PAYLOAD_CENSUS.map(([event, field]) => `${event}.${field}`)
  assert.equal(new Set(keys).size, keys.length, 'a payload field is recorded twice')
})

test('deleted event kinds are absent from the registry and from every reader', () => {
  for (const [kind, why] of DELETED_EVENT_KINDS) {
    assert.equal(Object.hasOwn(EVENT_VOCABULARY, kind), false, `${kind} is still in the vocabulary`)
    // Only executable readers count: source, tests and scripts. Documentation is
    // allowed — and expected — to keep naming a deleted kind, because that prose is
    // the historical record of the decision (docs/known-limitations.md, "Round 15
    // Pass 2"), not a reader of the surface.
    for (const path of TREE) {
      if (path === CENSUS_FILE) continue
      assert.equal(textOf(path).includes(kind), false, `${kind} is still referenced by ${path} (${why})`)
    }
    assert.equal(writersOf(kind).length, 0, `${kind}: a writer reappeared`)
  }
  // Positive control: the live sibling of each deleted kind keeps its writer and
  // its panel label, so the absence above is meaningful rather than a rename.
  for (const live of ['mission/pause', 'mission/resume', 'mission/stop', 'mission/complete']) {
    assert.ok(writersOf(live).length > 0, `${live}: the live dynamic kind lost its writer`)
    assert.ok(EVENT_PANEL_LABELS[live], `${live}: the live kind lost its panel label`)
  }
})

test('historical readability: an old log row with a deleted kind still replays with its data', async t => {
  const directory = await tempDirectory('swarm-reader-census-')
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(directory, { recursive: true, force: true }) })
  const store = new SwarmStore(join(directory, 'legacy.sqlite'))
  try {
    store.transaction(() => {
      store.event('mission-1', 'mission/paused', 'owner', { reason: 'pre-upgrade row written by an older build' })
      store.event('mission-1', 'mission/pause', 'owner', { reason: 'current row' })
    })
    const events = store.events('mission-1', 10)
    assert.deepEqual(events.map(event => event.type), ['mission/paused', 'mission/pause'])
    assert.equal(events[0].data.reason, 'pre-upgrade row written by an older build', 'the legacy row keeps its payload')
    const report = eventVocabularyReport(events)
    assert.ok(report.unrecognized.includes('mission/paused'), 'the removed description is reported as undescribed, not dropped')
    assert.equal(report.types.reduce((total, item) => total + item.count, 0), 2, 'both rows are still classified')
    assert.deepEqual(report.recognized, ['mission/pause'], 'the live kind keeps its description')
  } finally { store.close() }
})
