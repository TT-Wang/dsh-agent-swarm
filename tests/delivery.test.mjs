import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import filesystem from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { applyDelivery, inspectDelivery } from '../lib/delivery.js'

const execute = promisify(execFile)
async function git(cwd, ...args) {
  return (await execute('git', ['-c', 'user.name=Delivery Test', '-c', 'user.email=delivery@localhost', '-c', 'core.hooksPath=/dev/null', ...args], { cwd })).stdout.trim()
}
async function fixture(t, initial = { 'answer.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n', 'notes.txt': 'committed notes\n' }) {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-delivery-test-')))
  const source = path.join(temporary, 'source')
  await mkdir(source)
  await git(source, 'init', '-b', 'main')
  for (const [name, value] of Object.entries(initial)) { await mkdir(path.dirname(path.join(source, name)), { recursive: true }); await writeFile(path.join(source, name), value) }
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'initial')
  const head = await git(source, 'rev-parse', 'HEAD')
  const worker = path.join(temporary, 'worker')
  await git(source, 'worktree', 'add', '--detach', worker, head)
  t.after(async () => { await rm(temporary, { recursive: true, force: true }) })
  return { temporary, source, worker, head }
}
async function commit(worker, message = 'result') { await git(worker, 'add', '-A'); await git(worker, 'commit', '-m', message); return await git(worker, 'rev-parse', 'HEAD') }
async function headAndIndex(source) { return { head: await git(source, 'rev-parse', 'HEAD'), index: await readFile(path.join(source, '.git', 'index')) } }
async function atRenameBarrier(barrier, callback) {
  const original = filesystem.rename
  filesystem.rename = async (from, to) => {
    await original(from, to)
    await barrier(from, to)
  }
  syncBuiltinESMExports()
  try { return await callback() }
  finally { filesystem.rename = original; syncBuiltinESMExports() }
}

test('delivery preview and application isolate the swarm delta while preserving HEAD, staged and unstaged WIP', async t => {
  const { source, worker, head } = await fixture(t)
  await writeFile(path.join(source, 'notes.txt'), 'user staged notes\n')
  await git(source, 'add', 'notes.txt')
  await writeFile(path.join(source, 'notes.txt'), 'user staged notes\nuser unstaged notes\n')
  await writeFile(path.join(source, 'untracked.txt'), 'user untracked\n')
  await writeFile(path.join(worker, 'notes.txt'), 'user staged notes\nuser unstaged notes\n')
  await writeFile(path.join(worker, 'untracked.txt'), 'user untracked\n')
  const baselineCommit = await commit(worker, 'snapshot of WIP')
  await writeFile(path.join(worker, 'answer.txt'), 'swarm answer\n')
  const resultCommit = await commit(worker)
  const input = { source, baselineCommit, resultCommit }
  const before = await headAndIndex(source)
  const preview = await inspectDelivery(input)
  assert.deepEqual(preview.changedPaths, ['answer.txt'])
  assert.match(preview.diff, /swarm answer/)
  assert.doesNotMatch(preview.diff, /user staged notes|user untracked/)
  assert.equal(preview.truncated, false)
  assert.deepEqual(await applyDelivery(input), { status: 'applied', changedPaths: ['answer.txt'], conflicts: [] })
  assert.deepEqual(await headAndIndex(source), before)
  assert.equal(before.head, head)
  assert.equal(await readFile(path.join(source, 'notes.txt'), 'utf8'), 'user staged notes\nuser unstaged notes\n')
  assert.equal(await readFile(path.join(source, 'untracked.txt'), 'utf8'), 'user untracked\n')
  assert.equal(await readFile(path.join(source, 'answer.txt'), 'utf8'), 'swarm answer\n')
})

test('delivery merges later non-overlapping edits and repeated application preserves edits after delivery', async t => {
  const { source, worker, head } = await fixture(t)
  const base = await readFile(path.join(source, 'answer.txt'), 'utf8')
  await writeFile(path.join(source, 'answer.txt'), base.replace('one\n', 'local one\n'))
  await writeFile(path.join(worker, 'answer.txt'), base.replace('ten\n', 'swarm ten\n'))
  const input = { source, baselineCommit: head, resultCommit: await commit(worker) }
  const before = await headAndIndex(source)
  assert.equal((await applyDelivery(input)).status, 'applied')
  const expected = base.replace('one\n', 'local one\n').replace('ten\n', 'swarm ten\n')
  assert.equal(await readFile(path.join(source, 'answer.txt'), 'utf8'), expected)
  await writeFile(path.join(source, 'answer.txt'), expected + 'later local edit\n')
  assert.equal((await applyDelivery(input)).status, 'applied')
  assert.equal(await readFile(path.join(source, 'answer.txt'), 'utf8'), expected + 'later local edit\n')
  assert.deepEqual(await headAndIndex(source), before)
})

test('any conflict prevents every source write and leaves the result worktree untouched', async t => {
  const { source, worker, head } = await fixture(t)
  await writeFile(path.join(source, 'answer.txt'), 'local conflicting answer\n')
  await writeFile(path.join(worker, 'answer.txt'), 'swarm conflicting answer\n')
  await writeFile(path.join(worker, 'notes.txt'), 'non-conflicting swarm note\n')
  const resultCommit = await commit(worker)
  const before = await headAndIndex(source)
  assert.deepEqual(await applyDelivery({ source, baselineCommit: head, resultCommit }), { status: 'conflicts', changedPaths: ['answer.txt', 'notes.txt'], conflicts: ['answer.txt'] })
  assert.equal(await readFile(path.join(source, 'notes.txt'), 'utf8'), 'committed notes\n')
  assert.equal(await readFile(path.join(source, 'answer.txt'), 'utf8'), 'local conflicting answer\n')
  assert.equal(await readFile(path.join(worker, 'answer.txt'), 'utf8'), 'swarm conflicting answer\n')
  assert.deepEqual(await headAndIndex(source), before)
})

test('delivery handles additions, deletion, binary content, executable modes and leaf symlinks', async t => {
  const { source, worker, head } = await fixture(t)
  await rm(path.join(worker, 'notes.txt'))
  await writeFile(path.join(worker, 'answer.txt'), 'executable answer\n')
  await chmod(path.join(worker, 'answer.txt'), 0o755)
  await mkdir(path.join(worker, 'nested'))
  const bytes = Buffer.from([0, 255, 4, 0, 128, 5])
  await writeFile(path.join(worker, 'nested', 'binary.bin'), bytes)
  await symlink('../answer.txt', path.join(worker, 'nested', 'answer-link'))
  const input = { source, baselineCommit: head, resultCommit: await commit(worker) }
  const before = await headAndIndex(source)
  assert.equal((await applyDelivery(input)).status, 'applied')
  assert.equal((await lstat(path.join(source, 'answer.txt'))).mode & 0o111, 0o111)
  assert.deepEqual(await readFile(path.join(source, 'nested', 'binary.bin')), bytes)
  assert.equal(await readlink(path.join(source, 'nested', 'answer-link')), '../answer.txt')
  await assert.rejects(readFile(path.join(source, 'notes.txt')), { code: 'ENOENT' })
  assert.deepEqual(await headAndIndex(source), before)
})

test('divergent binary and symlink edits are conflicts without source writes', async t => {
  const { source, worker } = await fixture(t, { 'data.bin': Buffer.from([0, 1, 2]), 'target.txt': 'original\n' })
  await symlink('target.txt', path.join(worker, 'link'))
  const baselineCommit = await commit(worker, 'baseline with symlink')
  await symlink('target.txt', path.join(source, 'link'))
  await writeFile(path.join(source, 'data.bin'), Buffer.from([0, 2, 3]))
  await writeFile(path.join(worker, 'data.bin'), Buffer.from([0, 4, 5]))
  await rm(path.join(source, 'link'))
  await symlink('local.txt', path.join(source, 'link'))
  await rm(path.join(worker, 'link'))
  await symlink('swarm.txt', path.join(worker, 'link'))
  assert.deepEqual((await applyDelivery({ source, baselineCommit, resultCommit: await commit(worker) })).conflicts, ['data.bin', 'link'])
  assert.equal(await readlink(path.join(source, 'link')), 'local.txt')
  assert.deepEqual(await readFile(path.join(source, 'data.bin')), Buffer.from([0, 2, 3]))
})

test('symlink parents cannot redirect application outside the source', async t => {
  const { source, worker, head, temporary } = await fixture(t)
  const outside = path.join(temporary, 'outside')
  await mkdir(outside)
  await writeFile(path.join(outside, 'secret.txt'), 'untouched\n')
  await symlink(outside, path.join(source, 'nested'))
  await mkdir(path.join(worker, 'nested'))
  await writeFile(path.join(worker, 'nested', 'secret.txt'), 'swarm change\n')
  await assert.rejects(applyDelivery({ source, baselineCommit: head, resultCommit: await commit(worker) }), /symlink parent/)
  assert.equal(await readFile(path.join(outside, 'secret.txt'), 'utf8'), 'untouched\n')
  const alias = path.join(temporary, 'alias')
  await symlink(source, alias)
  await assert.rejects(inspectDelivery({ source: alias, baselineCommit: head, resultCommit: head }), /canonical/)
})

test('delivery rejects unrelated result histories and cancellation before any source write', async t => {
  const { source, worker, head } = await fixture(t)
  await writeFile(path.join(worker, 'answer.txt'), 'swarm answer\n')
  const resultCommit = await commit(worker)
  await assert.rejects(applyDelivery({ source, baselineCommit: resultCommit, resultCommit: head }), /does not descend/)
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(applyDelivery({ source, baselineCommit: head, resultCommit }, abort.signal))
  assert.equal(await readFile(path.join(source, 'answer.txt'), 'utf8'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n')
})

test('a concurrent editor stops delivery; rollback restores earlier files without overwriting the new edit', async t => {
  const { source, worker, head } = await fixture(t, { 'a.txt': 'original A\n', 'b.txt': 'original B\n' })
  await writeFile(path.join(worker, 'a.txt'), 'swarm A\n')
  await writeFile(path.join(worker, 'b.txt'), 'swarm B\n')
  const input = { source, baselineCommit: head, resultCommit: await commit(worker) }
  const before = await headAndIndex(source)
  let edited = false
  await atRenameBarrier(async (_from, to) => {
    if (!edited && to.startsWith(path.join(source, 'b.txt.swarm-backup-'))) {
      edited = true
      await writeFile(path.join(source, 'b.txt'), 'later editor B\n')
    }
  }, async () => { await assert.rejects(applyDelivery(input), /Delivery stopped|Local file changed|EEXIST/) })
  assert.equal(edited, true)
  assert.equal(await readFile(path.join(source, 'a.txt'), 'utf8'), 'original A\n')
  assert.equal(await readFile(path.join(source, 'b.txt'), 'utf8'), 'later editor B\n')
  assert.deepEqual(await headAndIndex(source), before)
})

test('cancellation during publication rolls back source files and leaf symlinks', async t => {
  const { source, worker } = await fixture(t, { 'b.txt': 'original B\n' })
  await symlink('original-target', path.join(worker, 'a-link'))
  await symlink('original-target', path.join(source, 'a-link'))
  const baselineCommit = await commit(worker, 'symlink baseline')
  await rm(path.join(worker, 'a-link'))
  await symlink('swarm-target', path.join(worker, 'a-link'))
  await writeFile(path.join(worker, 'b.txt'), 'swarm B\n')
  const input = { source, baselineCommit, resultCommit: await commit(worker) }
  const before = await headAndIndex(source)
  const controller = new AbortController()
  await atRenameBarrier(async (_from, to) => {
    if (to.startsWith(path.join(source, 'b.txt.swarm-backup-'))) controller.abort()
  }, async () => { await assert.rejects(applyDelivery(input, controller.signal)) })
  assert.equal(controller.signal.aborted, true)
  assert.equal(await readlink(path.join(source, 'a-link')), 'original-target')
  assert.equal(await readFile(path.join(source, 'b.txt'), 'utf8'), 'original B\n')
  assert.deepEqual(await headAndIndex(source), before)
})
