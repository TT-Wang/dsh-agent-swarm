import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { arenaView, pendingReadiness } from '../lib/arena.js'
import { formatDiagnostic } from '../lib/admission.js'
import { budget as sharedBudget, makeRuntime } from './faults/harness.mjs'

const budget = { ...sharedBudget, maxTokens: 100000, maxSteps: 100, maxWorkers: 2 }
async function fixture(t) {
  const { dir: directory, runtime } = await makeRuntime(t, { config: { tickMs: 60000, maxEvents: 100, checkTimeoutMs: undefined } })
  runtime.kick = () => {}
  return { directory, runtime, owner: { sessionId: 'owner' } }
}

test('draft create and edit share one advisory result but reread repository checks on the next operation', async t => {
  const f = await fixture(t)
  const packagePath = join(f.directory, 'package.json')
  await writeFile(packagePath, '{"scripts":{}}')
  const checks = Array.from({ length: 25 }, (_, i) => `npm run check${i}`)
  const input = { title: 'Advisory consistency', objective: 'Implement verified change', workspace: f.directory, scope: ['src/'], acceptance: ['works'], budget,
    members: [{ key: 'builder', name: 'Builder', role: 'implementation' }],
    workstreams: [{ key: 'main', title: 'Work', objective: 'Implement change' }],
    tasks: [{ key: 'code', workstreamKey: 'main', title: 'Code', objective: 'Implement change', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks }] }
  const read = fs.readFileSync
  let reads = 0
  t.mock.method(fs, 'readFileSync', (file, ...args) => { if (file === packagePath) reads++; return read(file, ...args) })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const draft = f.runtime.createDraft(f.owner, input)
  assert.equal(reads, 2, 'one validation read and one advisory read')
  const staged = f.runtime.store.events(draft.id, 100).find(event => event.type === 'plan/staged').data.advisories
  assert.equal(staged.length, 25)
  assert.deepEqual(draft.advisories, staged.slice(0, 20).map(formatDiagnostic))
  await writeFile(packagePath, JSON.stringify({ scripts: Object.fromEntries(checks.map((_, i) => [`check${i}`, 'node --test'])) }))
  reads = 0
  const edited = f.runtime.updateDraft(f.owner, draft.id, draft.revision, input)
  assert.equal(reads, 2)
  assert.deepEqual(edited.advisories, [])
  assert.deepEqual(f.runtime.store.events(draft.id, 100).find(event => event.type === 'plan/edited').data.advisories, [])
  reads = 0
  assert.throws(() => f.runtime.updateDraft(f.owner, draft.id, draft.revision, input), error => error.code === 'draft_revision_conflict')
  assert.equal(reads, 0, 'stale writes still fail before repository inspection')
})

const task = (missionId, id, status, extra = {}) => ({ id, missionId, workstreamId: 'work', title: id, objective: 'Work', kind: 'implementation', status,
  dependencies: [], scope: ['src/'], acceptance: ['works'], checks: [], priority: 50, experiment: false, epoch: 0, evidenceIds: [], proposedBy: 'owner', createdAt: 1, ...extra })

test('synchronous graph reuse keeps repair deduplication and sees changed carriers on the next read', async t => {
  const f = await fixture(t)
  const mission = f.runtime.create(f.owner, { title: 'Graph freshness', objective: 'Preserve graph policy', workspace: f.directory, scope: ['src/'], acceptance: ['works'], budget })
  const original = task(mission.id, 'original', 'cancelled'), other = task(mission.id, 'other', 'blocked')
  const repair = task(mission.id, 'repair', 'pending', { replaces: [original.id, other.id] })
  const dependent = task(mission.id, 'dependent', 'pending', { dependencies: [original.id, other.id, original.id] })
  const review = task(mission.id, 'review', 'pending', { kind: 'verification', reviewOf: original.id })
  const members = [{ id: 'worker', name: 'Worker', role: 'implementation', status: 'idle', subscriptions: [] }]
  for (const row of [original, other, repair, dependent, review]) f.runtime.store.put('tasks', row)
  const rows = () => f.runtime.store.list('tasks', mission.id)
  const board = () => arenaView({ missionId: mission.id, mission, tasks: rows(), members, evidence: [], deliveries: [], now: 1, leaseMs: 60000 })
  assert.deepEqual(f.runtime.unfinishedDependencies(mission.id, dependent).map(row => row.id), [repair.id])
  assert.deepEqual(f.runtime.effectiveDependencies(mission.id, dependent).map(row => row.id), [repair.id])
  const before = board()
  assert.equal(before.pendingDispatchable, 1)
  repair.status = 'accepted'; f.runtime.store.put('tasks', repair)
  assert.deepEqual(f.runtime.unfinishedDependencies(mission.id, dependent), [])
  assert.equal(pendingReadiness(rows(), members).ready, 1, 'the dependent becomes ready; exact reviewOf stays cancelled')
  assert.notEqual(board().fingerprint, before.fingerprint)
  const competing = task(mission.id, 'competing', 'accepted', { replaces: [original.id] })
  f.runtime.store.put('tasks', competing)
  assert.equal(pendingReadiness(rows(), members).ready, 0, 'a newly ambiguous carrier cannot satisfy a dependency')
  assert.deepEqual(f.runtime.unfinishedDependencies(mission.id, dependent).map(row => row.id), [original.id])
  assert.deepEqual(f.runtime.unfinishedDependencies(mission.id, { ...dependent, dependencies: ['missing'] }), [])
  assert.throws(() => f.runtime.effectiveDependencies(mission.id, { ...dependent, dependencies: ['missing'] }), /not in this mission/)
})
