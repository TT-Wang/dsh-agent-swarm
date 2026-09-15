import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { SwarmStore, StaleTaskRevisionError } from '../lib/store.js'

const storeModule = import.meta.resolve('../lib/store.js')
const options = { snapshotIntervalMs: 0 }
function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), 'r12-store-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return join(directory, 'state.sqlite')
}
function seed(t) {
  const path = scratch(t), store = new SwarmStore(path, options)
  store.transaction(() => store.put('missions', { id: 'm', ownerSessionId: 'owner', status: 'active', title: 'snapshot' }))
  const snapshot = store.snapshot().path
  store.close()
  return { path, snapshot }
}
function killedWriter(path) {
  const code = `import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(${JSON.stringify(path)});
    db.exec('PRAGMA wal_autocheckpoint=0');
    db.prepare('UPDATE missions SET value=? WHERE id=?').run(JSON.stringify({id:'m',ownerSessionId:'owner',status:'active',title:'newer-wal'}),'m');
    process.kill(process.pid,'SIGKILL');`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 5000 })
  assert.equal(result.signal, 'SIGKILL', result.stderr)
  assert.equal(existsSync(`${path}-wal`), true)
}

for (const phase of ['before-intent', 'before-main-rename', 'after-main-rename', 'after-wal-removal']) {
  test(`R12: interrupted restore recovers safely at ${phase}`, t => {
    const { path, snapshot } = seed(t)
    killedWriter(path)
    const code = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      import { SwarmStore } from ${JSON.stringify(storeModule)};
      const state=${JSON.stringify(path)}, phase=${JSON.stringify(phase)};
      const rename=fs.renameSync, rm=fs.rmSync;
      fs.renameSync=(from,to)=>{
        if ((phase==='before-main-rename' && to===state) || (phase==='before-intent' && to===state+'.restore-intent.json')) process.kill(process.pid,'SIGKILL');
        rename(from,to);
        if (phase==='after-main-rename' && to===state) process.kill(process.pid,'SIGKILL');
      };
      fs.rmSync=(file,options)=>{ rm(file,options); if (phase==='after-wal-removal' && file===state+'-wal') process.kill(process.pid,'SIGKILL'); };
      syncBuiltinESMExports(); SwarmStore.restore(state,${JSON.stringify(snapshot)});`
    const result = spawnSync(process.execPath, [...process.execArgv.filter(arg => arg !== '--test'), '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10000 })
    assert.equal(result.signal, 'SIGKILL', result.stderr)
    const recovered = new SwarmStore(path, options)
    try {
      assert.equal(recovered.get('missions', 'm').title, phase === 'before-intent' ? 'newer-wal' : 'snapshot')
      assert.equal(existsSync(`${path}.restore-intent.json`), false)
    } finally { recovered.close() }
  })
}

test('R12: bad restore intent cannot traverse paths or discard the current WAL', t => {
  const { path } = seed(t)
  killedWriter(path)
  const walBefore = readFileSync(`${path}-wal`)
  writeFileSync(`${path}.restore-intent.json`, JSON.stringify({ version: 1, staging: '../unrelated.sqlite', sha256: 'a'.repeat(64) }))
  assert.throws(() => new SwarmStore(path, options), /Invalid restore intent/)
  assert.deepEqual(readFileSync(`${path}-wal`), walBefore)
  rmSync(`${path}.restore-intent.json`)
  const store = new SwarmStore(path, options)
  try { assert.equal(store.get('missions', 'm').title, 'newer-wal') } finally { store.close() }
})

test('R12: an installed-database digest mismatch preserves files and requires inspection', t => {
  const { path } = seed(t)
  killedWriter(path)
  const walBefore = readFileSync(`${path}-wal`)
  writeFileSync(`${path}.restore-intent.json`, JSON.stringify({ version: 1,
    staging: 'state.sqlite.restore-00000000-0000-0000-0000-000000000000.tmp', sha256: '0'.repeat(64) }))
  assert.throws(() => new SwarmStore(path, options), /does not match/)
  assert.deepEqual(readFileSync(`${path}-wal`), walBefore)
})

test('R12: restore staging cannot be a symlink even with a matching digest', t => {
  const { path, snapshot } = seed(t)
  const staging = `${path}.restore-00000000-0000-0000-0000-000000000000.tmp`
  symlinkSync(snapshot, staging)
  writeFileSync(`${path}.restore-intent.json`, JSON.stringify({ version: 1, staging: staging.split('/').at(-1),
    sha256: createHash('sha256').update(readFileSync(snapshot)).digest('hex') }))
  assert.throws(() => new SwarmStore(path, options), /does not match/)
  assert.equal(existsSync(snapshot), true)
})

test('R12: a swallowed stale-write error is audited in its successful transaction', t => {
  const path = scratch(t), store = new SwarmStore(path, options)
  t.after(() => store.close())
  store.transaction(() => store.put('tasks', { id: 'task', missionId: 'm', status: 'pending', epoch: 1 }))
  const stale = store.get('tasks', 'task')
  store.transaction(() => { const current = store.get('tasks', 'task'); current.priority = 2; store.put('tasks', current) })
  const before = store.revision()
  store.transaction(() => {
    assert.throws(() => store.put('tasks', { ...stale, priority: 99 }), StaleTaskRevisionError)
    store.put('missions', { id: 'm', ownerSessionId: 'owner', status: 'active' })
  })
  assert.equal(store.get('tasks', 'task').priority, 2)
  assert.equal(store.events('m', 100).filter(event => event.type === 'task/stale-revision-refused').length, 1)
  assert.equal(store.revision(), before + 1, 'audit and successful work share one commit')
  store.transaction(() => store.event('m', 'probe', 'test', {}))
  assert.equal(store.events('m', 100).filter(event => event.type === 'task/stale-revision-refused').length, 1)
})

test('R12: matching or legacy live-PID locks remain authoritative for open and restore', t => {
  const { path, snapshot } = seed(t)
  const store = new SwarmStore(path, options)
  const ownLock = JSON.parse(readFileSync(`${path}.lock`, 'utf8'))
  assert.throws(() => new SwarmStore(path, options), /already owned/)
  assert.throws(() => SwarmStore.restore(path, snapshot), /already owned/)
  store.close()
  writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid, nonce: 'legacy' }))
  assert.throws(() => new SwarmStore(path, options), /already owned/)
  assert.throws(() => SwarmStore.restore(path, snapshot), /already owned/)
  assert.equal(JSON.parse(readFileSync(`${path}.lock`, 'utf8')).nonce, 'legacy')
  writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid, nonce: 'unknown', birth: 'unrecognized-birth' }))
  assert.throws(() => new SwarmStore(path, options), /already owned/)
  assert.throws(() => SwarmStore.restore(path, snapshot), /already owned/)
  assert.equal(typeof ownLock.pid, 'number')
})

test('R12: a demonstrably reused PID is reclaimed by both open and restore', t => {
  const { path, snapshot } = seed(t)
  const store = new SwarmStore(path, options)
  const ownLock = JSON.parse(readFileSync(`${path}.lock`, 'utf8'))
  store.close()
  if (ownLock.birth === undefined) { t.skip('host cannot establish process birth; conservative refusal is covered'); return }
  const reused = { ...ownLock, nonce: 'old-generation', birth: ownLock.birth.startsWith('linux:')
    ? ownLock.birth.replace(/:\d+$/, ':0') : ownLock.birth.replace(/\d{4}$/, '1900') }
  writeFileSync(`${path}.lock`, JSON.stringify(reused))
  const reopened = new SwarmStore(path, options)
  assert.notEqual(JSON.parse(readFileSync(`${path}.lock`, 'utf8')).nonce, reused.nonce)
  reopened.close()
  writeFileSync(`${path}.lock`, JSON.stringify(reused))
  assert.equal(SwarmStore.restore(path, snapshot).restoredFrom, snapshot)
  assert.equal(existsSync(`${path}.lock`), false)
})

test('R12: old task facts and trace parents have indexed exact lookups independent of later noise', t => {
  const path = scratch(t), store = new SwarmStore(path, options)
  t.after(() => store.close())
  store.transaction(() => {
    store.event('m', 'task/submitted', 'worker', { taskId: 'task', attemptId: 'attempt' })
    store.event('m', 'trace/span', 'runtime', { id: 'claim', taskId: 'task', attemptId: 'attempt', step: 'swarm_claim' })
    for (let i = 0; i < 20; i++) store.event('m', 'noise', 'test', {})
    store.event('m', 'trace/span', 'runtime', { id: 'work', taskId: 'task', attemptId: 'attempt', step: 'tool' })
  })
  assert.equal(store.latestTaskEvent('m', 'task', 'task/submitted').data.taskId, 'task')
  assert.equal(store.traceEvents('m', 1, { attemptId: 'attempt', step: 'swarm_claim' })[0].data.id, 'claim')
  assert.deepEqual(store.traceEvents('m', 2).map(event => event.data.id), ['claim', 'work'])
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => row.name)
    assert.ok(indexes.includes('events_task_fact'))
    assert.ok(indexes.includes('events_trace_attempt'))
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM events WHERE mission_id=? AND type=? AND json_extract(data,'$.taskId')=? ORDER BY seq DESC LIMIT 1").all('m', 'task/submitted', 'task')
    assert.match(JSON.stringify(plan), /events_task_fact/)
  } finally { db.close() }
})

test('R12: a recovered admission batch retains every refusal when merging an existing row', t => {
  const store = new SwarmStore(scratch(t), options)
  t.after(() => store.close())
  const row = { id: 'admission', missionId: 'm', memberId: 'member', taskId: 'task', epoch: 1, reason: 'writer_busy', admitted: false,
    taskClass: 'research', scope: '**', count: 1, latencyMs: 0, detail: 'busy', firstAt: 1, lastAt: 1 }
  store.transaction(() => store.recordAdmission(row))
  store.transaction(() => store.recordAdmission({ ...row, count: 3, firstAt: 2, lastAt: 3 }))
  assert.equal(store.get('admissions', row.id).count, 4)
  assert.equal(store.get('admissions', row.id).firstAt, 1)
})
