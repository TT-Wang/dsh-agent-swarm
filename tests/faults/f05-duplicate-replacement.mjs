/** F5: two replacements proposed for one blocked task. The second is rejected and lineage resolves to one task. */
import assert from 'node:assert/strict'
import { setup, blockThroughReview, clone, runScenario, MISSION_ACCEPTANCE } from './harness.mjs'

await runScenario({
  id: 'F5', title: 'A blocked task admits one live replacement and lineage stays deterministic', invariants: ['I6'],
  body: async () => {
    const f = await setup()
    try {
      const task = f.propose()
      await blockThroughReview(f, task)
      assert.equal(f.runtime.store.get('tasks', task.id).status, 'blocked', 'the fault target is blocked before injection')
      // Injection: a first replacement is admitted, a second must be rejected.
      const replacement = f.propose({ title: 'Repair the blocked work', replaces: [task.id] })
      assert.equal(replacement.status, 'pending', 'the first replacement is admitted')
      let duplicate
      assert.throws(() => f.propose({ title: 'Second replacement', replaces: [task.id] }), error => { duplicate = error; return true })
      assert.match(duplicate.message, /already replaced by/, 'the duplicate is rejected at admission')
      assert.match(duplicate.message, new RegExp(replacement.id), 'the rejection names the live replacement')
      const live = f.runtime.snapshot(f.owner, f.mission.id).tasks.filter(candidate => candidate.replaces?.includes(task.id) && candidate.status !== 'cancelled')
      assert.equal(live.length, 1, 'I6: at most one live replacement exists')
      const chain = f.runtime.lineage(f.mission.id, task.id)
      assert.deepEqual(chain.map(item => item.id), [task.id, replacement.id], 'I6: lineage resolves to exactly one replacement')
      // Imported history with two accepted replacements still fails closed instead of trusting an arbitrary artifact.
      const imported = [0, 1].map(index => ({
        id: `imported_${index}`, missionId: f.mission.id, workstreamId: f.stream.id, title: `Imported ${index}`, objective: 'Imported accepted history',
        kind: 'implementation', dependencies: [], scope: ['**'], acceptance: clone(MISSION_ACCEPTANCE), checks: ['true'], status: 'accepted', priority: 0,
        experiment: false, epoch: 1, evidenceIds: [], replaces: [task.id], createdAt: Date.now() + index, artifact: { commit: String(index).repeat(40), baseCommit: 'b'.repeat(40), workspace: f.dir, changedPaths: [] },
      }))
      f.runtime.store.transaction(() => { for (const record of imported) f.runtime.store.put('tasks', record) })
      const ambiguous = f.runtime.lineage(f.mission.id, task.id)
      assert.equal(ambiguous.at(-1).status, 'blocked', 'I6: ambiguous imported history fails closed')
      assert.match(ambiguous.at(-1).output, /Ambiguous accepted replacements/, 'I6: the ambiguity is named, never resolved arbitrarily')
      return { replacement: replacement.id, rejected: duplicate.message.slice(0, 90), liveReplacements: live.length, imported: imported.map(item => item.id) }
    } finally { await f.cleanup() }
  },
})
