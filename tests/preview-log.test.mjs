/**
 * R7-02 / R7-03 regression tests for the pure helpers in
 * `scripts/preview-log.mjs`.
 *
 * Both defects were in `scripts/update-preview.mjs`; the selection and summary
 * logic now lives in exported pure helpers so these tests run without a live
 * preview host (`node --test tests/preview-log.test.mjs`).
 *
 * Every scenario also runs the *pre-fix* algorithm, inlined below as
 * executable counterevidence: the assertions that follow fail if the helpers
 * regress to the old behaviour.
 *   - pre-fix `awaitLaunchUrl` matched the whole append-only `server.log` and
 *     took the last token, so a previous host's token was recorded before the
 *     new host had printed anything (documented link then returned 401);
 *   - pre-fix `summarize()` hashed only `lib/index.js` and `lib/client.js`, so
 *     a sync replacing ten files and adding two missing modules reported one.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { changedPaths, selectLaunchUrl, summarizePaths } from '../scripts/preview-log.mjs'

const PORT = 5192
const token = name => `http://127.0.0.1:${PORT}/?token=${name}`
const sha256 = value => createHash('sha256').update(value).digest('hex')

/** Pre-fix R7-02 selection: last token match anywhere in the whole log. */
function preFixSelectLaunchUrl(logText) {
  const pattern = new RegExp(`http://127\\.0\\.0\\.1:${PORT}/\\?token=[A-Za-z0-9_.-]+`, 'g')
  const found = logText.match(pattern)
  return found ? found.at(-1) : undefined
}

/** Pre-fix R7-03 summary: only the two hard-coded entry files. */
function preFixSummarize(pluginDir) {
  return Object.fromEntries(['lib/index.js', 'lib/client.js']
    .filter(path => existsSync(join(pluginDir, path)))
    .map(path => [path, sha256(readFileSync(join(pluginDir, path)))]))
}

function tempTree(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'preview-log-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, relative)), { recursive: true })
    writeFileSync(join(root, relative), content)
  }
  return root
}

const logLine = message => `[2026-09-09T00:00:00.000Z] ${message}`

test('R7-02a: a stale token before the offset is never selected, even as the last token in the log', () => {
  const stale = token('previous-host-token')
  const log = `${logLine('started host 111')}\n${logLine(`restart complete: ${stale}`)}\n`
  const sinceOffset = log.length

  assert.equal(selectLaunchUrl(log, sinceOffset, PORT), undefined,
    'the token that was already in the append-only log must not be recorded for the new host')
  assert.equal(preFixSelectLaunchUrl(log), stale,
    'the pre-fix logic does select that stale token — this is the R7-02 defect')
})

test('R7-02b: a token appended after the offset is selected, and the newest appended token wins', () => {
  const stale = token('previous-host-token')
  const beforeStart = `${logLine('started host 111')}\n${logLine(`restart complete: ${stale}`)}\n`
  const sinceOffset = beforeStart.length
  const fresh = token('new-host-token')
  const grown = beforeStart + `${logLine('started host 222')}\n${logLine(`restart complete: ${fresh}`)}\n`

  assert.equal(selectLaunchUrl(grown, sinceOffset, PORT), fresh,
    'the first token printed after the new host started belongs to the new host')
  const regrown = grown + `${logLine(`another url: ${token('newest-host-token')}`)}\n`
  assert.equal(selectLaunchUrl(regrown, sinceOffset, PORT), token('newest-host-token'))
})

test('R7-02c: no token after the offset yields undefined so the rollback path stays reachable', () => {
  assert.equal(selectLaunchUrl('', 0, PORT), undefined)
  assert.equal(selectLaunchUrl(`${logLine('booting')}\n`, 0, PORT), undefined)

  const stale = `${logLine(`restart complete: ${token('previous-host-token')}`)}\n`
  assert.equal(selectLaunchUrl(stale, stale.length, PORT), undefined,
    'the new host has not printed anything yet')
  assert.equal(selectLaunchUrl(stale, stale.length + 4096, PORT), undefined,
    'a truncated or rotated log must not resurrect a token from before the offset')
})

test('R7-02: offset 0 preserves the pre-fix selection when the log has no prior token', () => {
  const fresh = token('only-host-token')
  const log = `${logLine('started host 111')}\n${logLine(`restart complete: ${fresh}`)}\n`
  assert.equal(selectLaunchUrl(log, 0, PORT), fresh)
  assert.equal(selectLaunchUrl(log, 0, PORT), preFixSelectLaunchUrl(log),
    'with no prior token the new helper and the old whole-file match agree')
})

test('R7-02: only tokens for the restart port are selected', () => {
  const log = `${logLine('started other')}\n${logLine(`restart complete: http://127.0.0.1:5193/?token=other-port`)}\n`
  assert.equal(selectLaunchUrl(log, 0, PORT), undefined)
  assert.equal(selectLaunchUrl(log, 0, 5193), 'http://127.0.0.1:5193/?token=other-port')
})

test('R7-03: summarizePaths hashes every packaged path and expands directory entries recursively', t => {
  const root = tempTree(t, {
    'package.json': '{"name":"demo"}',
    'lib/index.js': 'index-v1',
    'lib/client.js': 'client-v1',
    'lib/scheduler.js': 'scheduler-v1',
    'lib/nested/trace.js': 'trace-v1',
    'README.md': 'not packaged',
  })
  const entries = ['package.json', 'lib', 'lib/missing.js']
  const summary = summarizePaths(root, entries)

  assert.deepEqual(Object.keys(summary).sort(),
    ['lib/client.js', 'lib/index.js', 'lib/nested/trace.js', 'lib/scheduler.js', 'package.json'])
  assert.equal(summary['package.json'], sha256('{"name":"demo"}'))
  assert.equal(summary['lib/index.js'], sha256('index-v1'))
  assert.equal(summary['lib/scheduler.js'], sha256('scheduler-v1'))
  assert.equal(summary['lib/nested/trace.js'], sha256('trace-v1'))
  assert.equal('lib/missing.js' in summary, false, 'an entry missing on this side is omitted, not invented')
  assert.equal('README.md' in summary, false, 'a path outside the entry list is never hashed')

  assert.deepEqual(Object.keys(preFixSummarize(root)).sort(), ['lib/client.js', 'lib/index.js'],
    'the pre-fix summary misses scheduler.js and nested/trace.js — this is the R7-03 defect')
})

test('R7-03: changedPaths lists exactly the differing paths, including one missing on a side, and omits identical ones', t => {
  const before = tempTree(t, {
    'package.json': '{"name":"demo"}',
    'lib/index.js': 'index-same',
    'lib/client.js': 'client-old',
    'lib/legacy.js': 'removed-in-the-new-build',
  })
  const after = tempTree(t, {
    'package.json': '{"name":"demo"}',
    'lib/index.js': 'index-same',
    'lib/client.js': 'client-new',
    'lib/scheduler.js': 'added-in-the-new-build',
  })
  const entries = ['package.json', 'lib']
  const beforeSummary = summarizePaths(before, entries)
  const afterSummary = summarizePaths(after, entries)

  assert.deepEqual(changedPaths(beforeSummary, afterSummary),
    ['lib/client.js', 'lib/legacy.js', 'lib/scheduler.js'],
    'only differing bytes, plus the path missing on one side, are reported')
  assert.deepEqual(changedPaths(beforeSummary, beforeSummary), [],
    'no difference yields an empty changed list')
  assert.deepEqual(changedPaths({}, {}), [])
})

test('R7-03: a sync replacing ten files and adding two missing modules reports twelve changed paths', t => {
  const files = { 'package.json': '{"name":"demo"}', 'lib/client.js': 'client-identical' }
  for (let index = 1; index <= 9; index++) {
    const name = `lib/module-${String(index).padStart(2, '0')}.js`
    files[name] = `module-${index}-old`
  }
  const snapshotFiles = { ...files, 'lib/index.js': 'index-old' }
  const projectFiles = { ...files, 'lib/index.js': 'index-new', 'lib/scheduler.js': 'scheduler', 'lib/trace.js': 'trace' }
  for (let index = 1; index <= 9; index++) {
    const name = `lib/module-${String(index).padStart(2, '0')}.js`
    projectFiles[name] = `module-${index}-new`
  }
  const snapshot = tempTree(t, snapshotFiles)
  const project = tempTree(t, projectFiles)
  const entries = ['package.json', 'lib']

  const before = summarizePaths(snapshot, entries)
  const built = summarizePaths(project, entries)
  const changed = changedPaths(before, built)

  assert.equal(changed.length, 12, 'ten replaced files plus two newly added modules')
  assert.deepEqual(changed, [
    'lib/index.js', 'lib/module-01.js', 'lib/module-02.js', 'lib/module-03.js', 'lib/module-04.js',
    'lib/module-05.js', 'lib/module-06.js', 'lib/module-07.js', 'lib/module-08.js', 'lib/module-09.js',
    'lib/scheduler.js', 'lib/trace.js',
  ])
  assert.equal(changed.includes('lib/client.js'), false, 'identical bytes are not reported')
  assert.equal(changed.includes('package.json'), false, 'identical bytes are not reported')

  const preFixChanged = Object.keys(preFixSummarize(project))
    .filter(path => preFixSummarize(snapshot)[path] !== preFixSummarize(project)[path])
  assert.deepEqual(preFixChanged, ['lib/index.js'],
    'the pre-fix summary reports one changed file for this twelve-file sync — the R7-03 defect')
})
