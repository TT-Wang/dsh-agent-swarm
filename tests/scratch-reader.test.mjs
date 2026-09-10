/**
 * R16-G6: the one host-mediated read path for a member's own preserved scratch
 * content.
 *
 * The deterministic per-(mission, member) scratch root was already composed and
 * validated (`sessionEnvironment` / `assertCompositionScratch`), but nothing
 * could read it back, so cross-member relay fell back to a shared `/tmp` path and
 * the runtime's own rendezvous detector warned on the round-15 mission. This
 * suite pins the single read path the adapter now exposes, its structural
 * authorization (the caller can only reach the member row's own root) and the
 * bounded read contract. No tool was added: the swarm tool surface is unchanged,
 * which is asserted here so a second, wider path cannot appear unnoticed.
 *
 * Co-firing guards the tests exercise: the composition fence
 * (`assertCompositionScratch`) x the session composition (`sessionEnvironment`,
 * which creates the 0700 root) x the duplicate-path census (two members and two
 * missions never share a root) x the filesystem containment (lexical containment
 * and `realpath`, with symlinks refused rather than followed).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessWorkers } from '../lib/harness-workers.js'
import { SWARM_TOOLS } from '../lib/tools.js'
import { tempDirectory } from './temp-root.mjs'

const ctx = { on: () => () => {}, get: () => undefined, logger: { error: () => {}, warn: () => {}, info: () => {} } }

async function adapterFixture(t) {
  const root = await tempDirectory('swarm-scratch-reader-')
  const adapter = new HarnessWorkers(ctx, { workspacesRoot: join(root, 'ws'), checkTimeoutMs: 1000, maxCheckOutputBytes: 1000 })
  t.after(async () => { await adapter.dispose().catch(() => undefined); await rm(root, { recursive: true, force: true }) })
  return { root, adapter }
}

test('R16-G6: the adapter reads a member\'s own preserved scratch content through one contained path', async t => {
  const { adapter } = await adapterFixture(t)
  const missionId = 'mission_scratch'
  const owner = { id: 'member_owner', missionId }
  const peer = { id: 'member_peer', missionId }
  // The composition path creates each member's own 0700 root; content a member
  // preserved there is read back through the adapter, not through a shared root.
  const ownerEnv = await adapter.sessionEnvironment(missionId, owner.id)
  await mkdir(join(ownerEnv.TMPDIR, 'notes'), { recursive: true })
  await writeFile(join(ownerEnv.TMPDIR, 'notes', 'state.json'), '{"pending":1}\n')
  await writeFile(join(ownerEnv.TMPDIR, 'top.txt'), 'top\n')
  const peerEnv = await adapter.sessionEnvironment(missionId, peer.id)
  await writeFile(join(peerEnv.TMPDIR, 'secret.txt'), 'peer-only\n')
  assert.notEqual(ownerEnv.TMPDIR, peerEnv.TMPDIR, 'two members never share a scratch root')

  // 1. The owning member reads its own file and one bounded directory listing.
  const file = await adapter.readScratch(owner, 'notes/state.json')
  assert.equal(file.kind, 'file')
  assert.equal(file.content, '{"pending":1}\n')
  assert.equal(file.truncated, false)
  assert.equal(file.root, ownerEnv.TMPDIR, 'the read is rooted at the callers own scratch root')
  assert.equal(file.path, 'notes/state.json')
  const listing = await adapter.readScratch(owner)
  assert.deepEqual(listing.entries, ['notes', 'top.txt'], 'the root listing names only the caller\'s own entries')

  // 2. Containment and authorization: an absolute path, a traversal, a symlink
  // and a missing path are all refused; none can reach the peer's tree.
  await assert.rejects(adapter.readScratch(owner, join(ownerEnv.TMPDIR, 'top.txt')), /relative/, 'an absolute path is refused')
  await assert.rejects(adapter.readScratch(owner, '../member_peer/secret.txt'), /escapes/, 'a traversal is refused')
  await assert.rejects(adapter.readScratch(owner, '/etc/passwd'), /relative/, 'a host path is refused')
  await assert.rejects(adapter.readScratch(owner, 'missing.txt'), /does not exist/, 'a missing path is refused')
  await symlink(peerEnv.TMPDIR, join(ownerEnv.TMPDIR, 'escape'), 'dir')
  await assert.rejects(adapter.readScratch(owner, 'escape'), /symlink/, 'a symlink is refused, never followed')
  await assert.rejects(adapter.readScratch(owner, 'escape/secret.txt'), /outside/, 'a path through a symlinked parent cannot escape')
  assert.equal((await adapter.readScratch(peer, 'secret.txt')).content, 'peer-only\n', 'the peer reads its own root only')
  await assert.rejects(adapter.readScratch(owner, 'secret.txt'), /does not exist/, 'the same relative name resolves in the caller\'s own root, never the peer\'s')

  // 3. Bounded reads state truncation and never modify the content.
  const big = 'x'.repeat(4096)
  await writeFile(join(ownerEnv.TMPDIR, 'big.bin'), big)
  const bounded = await adapter.readScratch(owner, 'big.bin', { maxBytes: 64 })
  assert.equal(bounded.bytes, 64)
  assert.equal(bounded.truncated, true)
  assert.equal(bounded.content.length, 64)
  assert.equal(await readFile(join(ownerEnv.TMPDIR, 'big.bin'), 'utf8'), big, 'the read changes nothing')
  const capped = await adapter.readScratch(owner, '.', { maxEntries: 1 })
  assert.equal(capped.entries.length, 1)
  assert.equal(capped.truncated, true)

  // 4. One path only: no swarm tool was added for scratch, and the adapter's
  // read is the single host-mediated reader.
  assert.equal(SWARM_TOOLS.some(name => /scratch/i.test(name)), false, 'the tool surface is not widened')
  assert.equal(typeof adapter.readScratch, 'function')
  assert.equal(typeof adapter.scratchRoot, 'function')
})

test('R16-G6 pair: the composition fence refuses another member\'s root and the reader derives the same root', async t => {
  const { adapter } = await adapterFixture(t)
  const owner = { id: 'member_owner', missionId: 'mission_scratch' }
  const peer = { id: 'member_peer', missionId: 'mission_scratch' }
  const ownerEnv = await adapter.sessionEnvironment(owner.missionId, owner.id)
  await adapter.sessionEnvironment(peer.missionId, peer.id)
  assert.equal(ownerEnv.TMPDIR, adapter.scratchRoot(owner.missionId, owner.id), 'the composed root is the deterministic root the reader derives')
  assert.notEqual(adapter.scratchRoot(owner.missionId, owner.id), adapter.scratchRoot(owner.missionId, peer.id))
  assert.notEqual(adapter.scratchRoot(owner.missionId, owner.id), adapter.scratchRoot('mission_other', owner.id), 'another mission with the same member id is a different root')
})