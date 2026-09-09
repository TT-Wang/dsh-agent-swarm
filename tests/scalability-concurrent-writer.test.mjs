/**
 * D8 concurrent-writer boundary. SQLite WAL allows readers and one writer at a
 * time, and the store's exclusive lock refuses a second live runtime, so the
 * remaining contention is a classified `SQLITE_BUSY`. These tests prove it is
 * classified (never silently lost), retried with bounded backoff, and that no
 * committed row is lost — in-process and across real processes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { SwarmStore, WriterBusyError, isSqliteBusy, withWriterRetry } from '../lib/store.js'

const childScript = fileURLToPath(new URL('./fixtures/sqlite-writer-child.mjs', import.meta.url))
const mission = { id: 'mission-writer', title: 'writer boundary', objective: 'prove no lost update', workspace: '/inert', scope: ['**'], acceptance: ['one writer'],
  budget: { maxTokens: 1000, maxSteps: 100, maxWorkers: 2, maxDurationMs: 3600000, maxTasks: 4, maxExperiments: 0 },
  ownerSessionId: 'writer-owner', status: 'active', usedTokens: 0, usedSteps: 0, createdAt: 1, updatedAt: 1, deadline: 9999999999999 }

async function tempRoot(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function runChild(dbPath, tag, rows) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--no-warnings', childScript, dbPath, tag, String(rows)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    proc.stdout.on('data', chunk => { stdout += chunk })
    proc.stderr.on('data', chunk => { stderr += chunk })
    proc.on('error', reject)
    proc.on('exit', code => {
      if (code !== 0) return reject(new Error(`writer child ${tag} exited ${code}: ${stderr.trim()}`))
      try { resolve(JSON.parse(stdout.trim())) } catch (error) { reject(new Error(`writer child ${tag} printed ${JSON.stringify(stdout)}: ${String(error)}`)) }
    })
  })
}

test('isSqliteBusy classifies the real node:sqlite contention error', async t => {
  const root = await tempRoot(t, 'swarm-d8-busy-')
  const path = join(root, 'probe.sqlite')
  const holder = new DatabaseSync(path)
  const contender = new DatabaseSync(path)
  holder.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY); BEGIN IMMEDIATE')
  contender.exec('PRAGMA busy_timeout=0')
  try {
    assert.throws(() => contender.exec('BEGIN IMMEDIATE'), error => isSqliteBusy(error) && error.errcode === 5)
  } finally { holder.exec('ROLLBACK'); holder.close(); contender.close() }
})

test('a held write lock classifies as writer_busy and the retried transaction commits exactly once', async t => {
  const root = await tempRoot(t, 'swarm-d8-store-')
  const path = join(root, 'state.sqlite')
  const store = new SwarmStore(path, { busyTimeoutMs: 0, writerAttempts: 2, writerDelayMs: 1 })
  t.after(() => store.close())
  const blocker = new DatabaseSync(path)
  blocker.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE')
  try {
    assert.throws(() => store.transaction(() => store.put('missions', mission)),
      error => error instanceof WriterBusyError && error.reason === 'writer_busy' && error.attempts === 2)
  } finally { blocker.exec('ROLLBACK'); blocker.close() }
  store.transaction(() => store.put('missions', mission))
  assert.equal(store.get('missions', mission.id).title, 'writer boundary')
  assert.equal(store.list('missions').filter(row => row.id === mission.id).length, 1, 'the retry did not duplicate the row')
})

function lockHolder(dbPath, holdMs) {
  return new Promise((resolve, reject) => {
    const script = `const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(process.argv[1])
db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE')
process.stdout.write('locked\\n')
setTimeout(() => { db.exec('COMMIT'); db.close() }, Number(process.argv[2]))`
    const proc = spawn(process.execPath, ['--no-warnings', '-e', script, dbPath, String(holdMs)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', chunk => { stderr += chunk })
    proc.on('error', reject)
    proc.stdout.once('data', () => resolve(proc))
    proc.on('exit', code => { if (code !== 0) reject(new Error(`lock holder exited ${code}: ${stderr.trim()}`)) })
  })
}

test('withWriterRetry waits out a lock released by another process', async t => {
  const root = await tempRoot(t, 'swarm-d8-retry-')
  const path = join(root, 'retry.sqlite')
  const setup = new DatabaseSync(path)
  setup.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY)')
  setup.close()
  const holder = await lockHolder(path, 120)
  const writer = new DatabaseSync(path)
  writer.exec('PRAGMA busy_timeout=0')
  let busy = 0
  withWriterRetry(() => writer.exec('BEGIN IMMEDIATE; INSERT INTO t(id) VALUES(1); COMMIT'), {
    attempts: 2000, delayMs: 1,
    onBusy: (attempt, error) => { if (!isSqliteBusy(error)) throw error; busy++ },
  })
  await new Promise(resolve => holder.once('exit', resolve))
  assert.ok(busy > 0, 'the parent classified at least one SQLITE_BUSY while the other process held the lock')
  assert.equal(Number(writer.prepare('SELECT COUNT(*) AS count FROM t').get().count), 1, 'the retried write committed exactly once')
  writer.close()
})

test('a second live store owner is refused on the same state file', async t => {
  const root = await tempRoot(t, 'swarm-d8-lock-')
  const path = join(root, 'state.sqlite')
  const first = new SwarmStore(path)
  t.after(() => first.close())
  assert.throws(() => new SwarmStore(path), /already owned by process/)
})

test('concurrent processes classify and retry SQLITE_BUSY with no lost update', async t => {
  const root = await tempRoot(t, 'swarm-d8-writers-')
  const path = join(root, 'writers.sqlite')
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE writes(id TEXT PRIMARY KEY, tag TEXT NOT NULL, seq INTEGER NOT NULL)')
  const children = 8, perChild = 20
  // Hold the write lock while every child starts and tries its first insert, so
  // at least one SQLITE_BUSY is classified in every run.
  db.exec('BEGIN IMMEDIATE')
  const running = Promise.all(Array.from({ length: children }, (_, index) => runChild(path, `w${index}`, perChild)))
  await new Promise(resolve => setTimeout(resolve, 250))
  db.exec('COMMIT')
  const results = await running
  const total = Number(db.prepare('SELECT COUNT(*) AS count FROM writes').get().count)
  const distinct = Number(db.prepare('SELECT COUNT(DISTINCT id) AS count FROM writes').get().count)
  const tags = Number(db.prepare('SELECT COUNT(DISTINCT tag) AS count FROM writes').get().count)
  db.close()
  assert.equal(results.length, children)
  assert.ok(results.every(result => result.rows === perChild), `every child committed its rows: ${JSON.stringify(results)}`)
  assert.equal(total, children * perChild, 'no insert was lost')
  assert.equal(distinct, children * perChild, 'no primary key was duplicated or dropped')
  assert.equal(tags, children)
  assert.ok(results.reduce((sum, result) => sum + result.busy, 0) > 0, `at least one child classified SQLITE_BUSY: ${JSON.stringify(results)}`)
})
