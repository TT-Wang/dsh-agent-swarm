/**
 * F20 (R11-02): store snapshot and owner restore. A truncated store fails
 * closed naming its snapshot; a deleted store is detected instead of silently
 * starting empty; the owner restore path recovers the mission.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setup, makeRepo, runScenario, PROJECT } from './harness.mjs'

const { SwarmStore, StoreRecoveryError } = await import(pathToFileURL(join(PROJECT, 'lib/store.js')).href)
const { SwarmRuntime } = await import(pathToFileURL(join(PROJECT, 'lib/runtime.js')).href)

const config = statePath => ({ statePath, leaseMs: 60_000, tickMs: 10, maxMessageChars: 16_000, maxEvents: 5_000, maxTasksPerMember: 3, checkTimeoutMs: 30_000 })

await runScenario({
  id: 'F20', title: 'A truncated or deleted store fails closed and the owner restore recovers the mission', invariants: ['I2', 'I5'],
  body: async () => {
    const repo = await makeRepo('swarm-f20')
    const f = await setup({ workspace: repo.source })
    let reopened
    try {
      const task = f.propose()
      const statePath = join(f.dir, 'swarm.sqlite')
      // Owner action: one consistent snapshot of the live board.
      const snapshot = f.runtime.store.snapshot()
      assert.ok(existsSync(snapshot.path), 'the snapshot file exists')
      assert.ok(!snapshot.path.startsWith(`${repo.source}${sep}`), `snapshot ${snapshot.path} must not be written into the mission source checkout`)
      const probe = new SwarmStore(snapshot.path, { snapshotIntervalMs: 0 })
      try {
        assert.equal(probe.get('missions', f.mission.id).title, 'Fault injection', 'the snapshot carries the mission')
        assert.equal(probe.list('tasks', f.mission.id).length, 1, 'the snapshot carries the board')
      } finally { probe.close() }
      await f.runtime.dispose()

      // Injection 1: truncate the state file. Pre-fix the open failed with the
      // raw "file is not a database" and no recovery path was named.
      await writeFile(statePath, 'not a database')
      assert.throws(() => new SwarmStore(statePath, { snapshotIntervalMs: 0 }), error => {
        assert.ok(error instanceof StoreRecoveryError, `expected StoreRecoveryError, got ${error}`)
        assert.equal(error.code, 'store_corrupt')
        assert.ok(error.snapshots.includes(snapshot.path), 'the refusal names the snapshot')
        assert.match(error.message, /SwarmStore\.restore/, 'the refusal names the owner restore path')
        return true
      })
      SwarmStore.restore(statePath, snapshot.path)
      reopened = new SwarmRuntime(config(statePath), f.workers)
      await reopened.start()
      assert.equal(reopened.store.get('missions', f.mission.id).title, 'Fault injection', 'the mission is recovered from the snapshot')
      assert.equal(reopened.store.get('tasks', task.id).status, 'pending', 'the recovered board still holds the task')
      await reopened.dispose()
      reopened = undefined

      // Injection 2: delete the state file. Pre-fix the store silently started
      // empty; the board must instead be detected as lost.
      for (const suffix of ['', '-wal', '-shm', '.lock']) await rm(`${statePath}${suffix}`, { force: true })
      assert.throws(() => new SwarmStore(statePath, { snapshotIntervalMs: 0 }), error => {
        assert.ok(error instanceof StoreRecoveryError)
        assert.equal(error.code, 'store_missing_with_snapshots')
        assert.ok(error.snapshots.includes(snapshot.path))
        return true
      })
      SwarmStore.restore(statePath, SwarmStore.latestSnapshot(statePath))
      reopened = new SwarmRuntime(config(statePath), f.workers)
      await reopened.start()
      assert.equal(reopened.store.get('missions', f.mission.id).title, 'Fault injection', 'the deleted store is restored, not recreated empty')
      return { snapshot: snapshot.path, mission: f.mission.id, task: task.id, restoredRevision: reopened.store.revision() }
    } finally {
      if (reopened) await reopened.dispose().catch(() => undefined)
      await f.cleanup()
      await rm(repo.root, { recursive: true, force: true })
    }
  },
})
