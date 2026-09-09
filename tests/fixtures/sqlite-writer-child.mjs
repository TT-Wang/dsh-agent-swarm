/**
 * Child writer for the D8 concurrent-writer test. It opens the shared SQLite file
 * directly (a second runtime is refused by the store lock, so contention is
 * modelled with raw connections), inserts unique rows with bounded busy retries,
 * and reports how many SQLITE_BUSY conflicts it classified. It never runs git.
 *
 * Usage: node sqlite-writer-child.mjs <dbPath> <tag> <rowCount>
 * Prints one JSON line: { tag, rows, busy, attempts }
 */
import { DatabaseSync } from 'node:sqlite'
import { isSqliteBusy, withWriterRetry } from '../../lib/store.js'

const [dbPath, tag, count] = process.argv.slice(2)
const rows = Number(count)
if (!dbPath || !tag || !Number.isSafeInteger(rows) || rows < 1) throw new Error('usage: sqlite-writer-child.mjs <dbPath> <tag> <rowCount>')

const db = new DatabaseSync(dbPath)
db.exec('PRAGMA busy_timeout=0;')
const insert = db.prepare('INSERT INTO writes(id, tag, seq) VALUES(?,?,?)')
let busy = 0
for (let seq = 0; seq < rows; seq++) {
  withWriterRetry(() => insert.run(`${tag}-${seq}`, tag, seq), {
    attempts: 2000,
    delayMs: 1,
    onBusy: (attempt, error) => {
      if (!isSqliteBusy(error)) throw error
      busy++
    },
  })
}
db.close()
process.stdout.write(`${JSON.stringify({ tag, rows, busy })}\n`)
