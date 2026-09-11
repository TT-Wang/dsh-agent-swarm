/**
 * R11-02 regression: the mission store has a periodic snapshot and an owner
 * restore path, a truncated store fails closed naming the snapshot, and a
 * deleted store is detected instead of silently starting empty.
 *
 * Pre-fix head: `SwarmStore` has no `snapshot`, `restore` or recovery
 * classification, so every assertion here fails at the first missing method.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { SwarmStore, StoreRecoveryError, applyPendingRestore, isSqliteNotADatabase, pendingRestore } from '../lib/store.js'
import { SwarmRuntime } from '../lib/runtime.js'
import { MANAGEMENT_TOOLS, SWARM_TOOLS } from '../lib/tools.js'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 3, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 }

class RunWorkers {
  artifact = { commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: ['src/a.ts'] }
  checks = [{ command: 'test', exitCode: 0, output: 'ok' }]
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async start() {}
  async deliver() {}
  async stop() {}
  isIdle() { return false }
  async prepareTask() {}
  async captureArtifact() { return this.artifact }
  async verifyArtifact() { return this.checks }
  async dispose() {}
}

async function eventually(read, message, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`Timed out after ${timeoutMs}ms: ${message}`)
}

async function fixture(t, { storeOptions = {}, workspace } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-store-snapshot-'))
  const runtime = new SwarmRuntime({ statePath: join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 60000,
    maxMessageChars: 10000, maxEvents: 200, maxTasksPerMember: 10 }, new RunWorkers(), storeOptions)
  await runtime.start()
  const owner = { sessionId: 'snapshot-owner' }
  const mission = runtime.create(owner, { title: 'Snapshot', objective: 'Prove snapshot and restore', workspace: workspace ?? directory,
    scope: ['**'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Implement', objective: 'Implement',
    kind: 'implementation', scope: ['**'], acceptance: ['works'], checks: ['test'] })
  t.after(async () => { await runtime.dispose().catch(() => undefined); await rm(directory, { recursive: true, force: true }) })
  return { directory, statePath: join(directory, 'state.sqlite'), runtime, owner, mission }
}

test('R11-02: the periodic snapshot is written outside the mission source and contains the board', async t => {
  const source = await mkdtemp(join(tmpdir(), 'swarm-store-source-'))
  t.after(async () => rm(source, { recursive: true, force: true }))
  const f = await fixture(t, { workspace: source, storeOptions: { snapshotIntervalMs: 20, snapshotKeep: 3 } })
  const snapshot = await eventually(async () => (await f.runtime.store.snapshots())[0], 'the periodic timer writes a snapshot')
  assert.ok(snapshot.path.startsWith(`${f.statePath}.snapshots${sep}`), `snapshot ${snapshot.path} is derived from the owner state path, not the mission source`)
  assert.ok(!snapshot.path.startsWith(`${source}${sep}`), 'the snapshot is never written inside the mission source checkout')
  assert.ok(snapshot.bytes > 0)
  assert.equal(f.runtime.store.snapshotState().intervalMs, 20)
  // The snapshot is a complete database: the mission is readable from it directly.
  const probe = new SwarmStore(snapshot.path, { snapshotIntervalMs: 0 })
  try {
    assert.equal(probe.get('missions', f.mission.id)?.title, 'Snapshot', 'the snapshot carries the mission row')
    assert.equal(probe.list('tasks', f.mission.id).length, 1, 'the snapshot carries the board')
  } finally { probe.close() }
})

test('R11-02: a truncated store fails closed naming the snapshot, and restore recovers the mission', async t => {
  const f = await fixture(t, { storeOptions: { snapshotIntervalMs: 0 } })
  const snapshot = f.runtime.store.snapshot()
  await f.runtime.dispose()
  await writeFile(f.statePath, 'not a database at all')
  assert.throws(() => new SwarmStore(f.statePath, { snapshotIntervalMs: 0 }), error => {
    assert.ok(error instanceof StoreRecoveryError, `expected StoreRecoveryError, got ${error}`)
    assert.equal(error.code, 'store_corrupt')
    assert.match(error.message, /not a usable database/)
    assert.ok(error.snapshots.includes(snapshot.path), 'the error names the available snapshot')
    assert.match(error.message, /SwarmStore\.restore/)
    return true
  })
  const restored = SwarmStore.restore(f.statePath, snapshot.path)
  assert.equal(restored.restoredFrom, snapshot.path)
  const reopened = new SwarmStore(f.statePath, { snapshotIntervalMs: 0 })
  try {
    assert.equal(reopened.get('missions', f.mission.id)?.title, 'Snapshot', 'the mission is recovered from the snapshot')
    assert.equal(reopened.list('tasks', f.mission.id).length, 1)
  } finally { reopened.close() }
})

test('R11-02: a deleted store is detected instead of silently starting empty', async t => {
  const f = await fixture(t, { storeOptions: { snapshotIntervalMs: 0 } })
  const snapshot = f.runtime.store.snapshot()
  await f.runtime.dispose()
  for (const suffix of ['', '-wal', '-shm', '.lock']) await rm(`${f.statePath}${suffix}`, { force: true })
  assert.throws(() => new SwarmStore(f.statePath, { snapshotIntervalMs: 0 }), error => {
    assert.ok(error instanceof StoreRecoveryError)
    assert.equal(error.code, 'store_missing_with_snapshots')
    assert.ok(error.snapshots.includes(snapshot.path))
    return true
  })
  assert.equal(SwarmStore.latestSnapshot(f.statePath), snapshot.path, 'the newest snapshot is the restore point')
  SwarmStore.restore(f.statePath, SwarmStore.latestSnapshot(f.statePath))
  const reopened = new SwarmStore(f.statePath, { snapshotIntervalMs: 0 })
  try { assert.equal(reopened.get('missions', f.mission.id)?.title, 'Snapshot') } finally { reopened.close() }
})

test('R11-02: restore refuses while a live runtime owns the state file', async t => {
  const f = await fixture(t, { storeOptions: { snapshotIntervalMs: 0 } })
  const snapshot = f.runtime.store.snapshot()
  assert.throws(() => SwarmStore.restore(f.statePath, snapshot.path), error => {
    assert.ok(error instanceof StoreRecoveryError)
    assert.equal(error.code, 'restore_blocked')
    return true
  })
  await f.runtime.dispose()
  assert.equal(SwarmStore.restore(f.statePath, snapshot.path).restoredFrom, snapshot.path, 'a stopped host restores cleanly')
})

test('R11-02: restore reclaims a lock a crashed host left behind, and still refuses a live owner', async t => {
  const f = await fixture(t, { storeOptions: { snapshotIntervalMs: 0 } })
  const snapshot = f.runtime.store.snapshot()
  await f.runtime.dispose()
  const lockPath = `${f.statePath}.lock`
  // The shape a SIGKILL leaves: the lock file names a pid that no longer exists.
  // Before the fix this refused with restore_blocked, so the staged-restore path
  // could never run after the crash it exists for.
  await writeFile(lockPath, JSON.stringify({ pid: 999_999, nonce: 'crashed-host' }))
  const restored = SwarmStore.restore(f.statePath, snapshot.path)
  assert.equal(restored.restoredFrom, snapshot.path, 'a dead-pid lock does not block the restore it caused')
  assert.equal(existsSync(lockPath), false, 'the stale lock is reclaimed, exactly as acquireLock reclaims it')

  // A live owner still refuses, and the refusal names the one manual exit.
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, nonce: 'live-owner' }))
  assert.throws(() => SwarmStore.restore(f.statePath, snapshot.path), error => {
    assert.ok(error instanceof StoreRecoveryError)
    assert.equal(error.code, 'restore_blocked')
    assert.match(error.message, new RegExp(lockPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    return true
  })
  await rm(lockPath, { force: true })
})

test('R11-02: snapshot retention keeps the newest snapshots and prunes the rest', async t => {
  const f = await fixture(t, { storeOptions: { snapshotIntervalMs: 0, snapshotKeep: 2 } })
  for (let index = 0; index < 4; index++) f.runtime.store.snapshot()
  const kept = f.runtime.store.snapshots()
  assert.equal(kept.length, 2, 'only the configured number of snapshots is retained')
  for (const snapshot of kept) assert.ok((await stat(snapshot.path)).size > 0)
})

test('R11-02: corruption classification is separate from writer contention', () => {
  assert.equal(isSqliteNotADatabase(new Error('file is not a database')), true)
  assert.equal(isSqliteNotADatabase(Object.assign(new Error('x'), { code: 'SQLITE_NOTADB' })), true)
  assert.equal(isSqliteNotADatabase(Object.assign(new Error('x'), { code: 'SQLITE_BUSY' })), false)
})

test('R11-02: a default runtime carries the periodic snapshot configuration', async t => {
  const f = await fixture(t)
  const state = f.runtime.store.snapshotState()
  assert.ok(state.intervalMs > 0, 'the production default snapshots periodically without extra configuration')
  assert.equal(state.dir, `${f.statePath}.snapshots`)
  assert.equal(dirname(state.dir), dirname(f.statePath))
  const snapshot = f.runtime.store.snapshot()
  const header = (await readFile(snapshot.path)).subarray(0, 16).toString('latin1')
  assert.equal(header, 'SQLite format 3\u0000', 'the snapshot is a standalone SQLite database, not a copy of the WAL state')
})

test('R11-02: the owner staging surface records a request the composition applies at the next start', async t => {
  const f = await fixture(t, { storeOptions: { snapshotIntervalMs: 0 } })
  const snapshot = f.runtime.store.snapshot()
  const staged = f.runtime.requestRestore(f.owner, basename(snapshot.path))
  assert.equal(staged.snapshot, basename(snapshot.path))
  assert.equal(pendingRestore(f.statePath)?.snapshot, basename(snapshot.path), 'the request is durable')
  assert.ok(f.runtime.store.events('swarm/install', 100).some(event => event.type === 'store/restore-requested'))
  assert.ok(SWARM_TOOLS.includes('swarm_restore'), 'the owner surface is a registered tool')
  assert.ok(MANAGEMENT_TOOLS.includes('swarm_restore'), 'the owner surface is management-only, never worker-callable')
  assert.throws(() => f.runtime.requestRestore({ sessionId: 'not-the-owner' }, basename(snapshot.path)), /Only the mission owner/)
  assert.throws(() => f.runtime.requestRestore(f.owner, '../outside.snapshot.sqlite'), /managed snapshot directory/)
  await f.runtime.dispose()
  const applied = applyPendingRestore(f.statePath)
  assert.equal(applied?.snapshot, snapshot.path, 'the composition applies the staged snapshot')
  assert.equal(pendingRestore(f.statePath), undefined, 'the request is consumed exactly once')
  const reopened = new SwarmStore(f.statePath, { snapshotIntervalMs: 0 })
  try {
    assert.equal(reopened.get('missions', f.mission.id)?.title, 'Snapshot', 'the applied restore recovers the board')
  } finally { reopened.close() }
})

test('R11-02: a staged restore never applies under a live runtime', async t => {
  const f = await fixture(t, { storeOptions: { snapshotIntervalMs: 0 } })
  const snapshot = f.runtime.store.snapshot()
  f.runtime.requestRestore(f.owner, basename(snapshot.path))
  assert.throws(() => applyPendingRestore(f.statePath), error => {
    assert.ok(error instanceof StoreRecoveryError)
    assert.equal(error.code, 'restore_blocked')
    return true
  })
})
