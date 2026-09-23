/**
 * R7-03 regression tests for the pure helpers in `scripts/preview-log.mjs`.
 *
 * The defect was in `scripts/update-preview.mjs`; the summary logic now lives
 * in exported pure helpers so these tests run without a live preview host
 * (`node --test tests/preview-log.test.mjs`).
 *
 * Every scenario also runs the *pre-fix* algorithm, inlined below as
 * executable counterevidence: pre-fix `summarize()` hashed only `lib/index.js`
 * and `lib/client.js`, so a sync replacing ten files and adding two missing
 * modules reported one. (R7-02, the stale launch token, is covered by
 * tests/host.test.mjs: every boot now gets a fresh server.log.)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { changedPaths, summarizePaths } from '../scripts/preview-log.mjs'

const sha256 = value => createHash('sha256').update(value).digest('hex')

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
