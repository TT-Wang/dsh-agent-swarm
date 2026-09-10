/** Apply only the swarm's immutable delta, without touching the source HEAD or index. */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertContainedSymlinkChain, type SymlinkChainLookup } from './workspaces.js'

export interface DeliveryInput { source: string; baselineCommit: string; resultCommit: string }
export interface DeliveryInspection { baselineCommit: string; resultCommit: string; changedPaths: string[]; diff: string; truncated: boolean }
export interface DeliveryApplication { status: 'applied' | 'conflicts'; changedPaths: string[]; conflicts: string[] }
interface Entry { kind: 'file' | 'symlink'; bytes: Buffer; mode: number }
interface Local { entry?: Entry; fingerprint: string; directory?: boolean }
interface Change { relative: string; original: Local; output?: Entry }
interface Written { change: Change; backup?: string; published?: Local }
const MAX_BYTES = 64 * 1024 * 1024
const MAX_DIFF = 256 * 1024
const activeSources = new Set<string>()
const sourceIdentities = new Map<string, string>()
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }
function sha(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
function same(a?: Entry, b?: Entry): boolean { return a === undefined || b === undefined ? a === b : a.kind === b.kind && a.mode === b.mode && a.bytes.equals(b.bytes) }
/**
 * R15-F5: one scratch directory under the ambient temp root, with a
 * checkout-local fallback when the environment denies that root.
 *
 * The host check sandbox roots its write policy at the disposable checkout
 * while `TMPDIR`/`TMP`/`TEMP` stay inherited from the caller, so the ambient
 * root can be unwritable (EPERM/EACCES), missing (ENOENT) or a file (ENOTDIR)
 * and an unguarded `mkdtemp` then fails the operation. Only those four codes
 * fall through; any other failure is a real error and is rethrown rather than
 * hidden behind a second attempt.
 *
 * The fallback root is caller-declared and must be a path capture cannot read as
 * work: production passes the delivery's own private metadata directory inside
 * `.git`, and `tests/temp-root.mjs` re-exports this helper with its git-ignored
 * `.swarm/test-tmp` default, so the fixtures and the production path cannot
 * drift apart. Each call gets its own `mkdtemp` directory and the caller keeps
 * its existing cleanup obligation.
 */
const FALLBACK_TEMP_CODES = new Set(['EPERM', 'EACCES', 'ENOENT', 'ENOTDIR'])
export async function tempDirectory(prefix: string, fallbackRoot: string = path.join(process.cwd(), '.swarm', 'test-tmp')): Promise<string> {
  try { return await mkdtemp(path.join(tmpdir(), prefix)) } catch (error) {
    if (!(error instanceof Error && 'code' in error && FALLBACK_TEMP_CODES.has(String(error.code)))) throw error
    await mkdir(fallbackRoot, { recursive: true })
    return await mkdtemp(path.join(fallbackRoot, prefix))
  }
}
function validPath(value: string): void {
  if (!value || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || part.includes(':'))) throw new Error(`Unsafe delivery path: ${JSON.stringify(value)}`)
}
/** A delivery never materializes a link whose resolved chain leaves the repository. */
function decodeTarget(relative: string, target: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(target) } catch { throw new Error(`Delivery symlink target is not valid UTF-8: ${relative}`) }
}
/**
 * Resolve one path in the result commit, falling back to the source working
 * tree for paths the commit does not contain. A delivered link is followed
 * through the commit (the authoritative post-apply tree) and through any
 * user-local link it would traverse after apply, so a chain through a
 * pre-existing escaping link is refused before the first write (F-C1).
 */
function resultLookup(source: string, commit: string, signal?: AbortSignal): SymlinkChainLookup {
  return async relative => {
    const row = (await git(source, ['ls-tree', '-z', commit, '--', relative], signal)).output.toString('utf8')
    const match = /^(\d+) (blob|tree|commit) ([a-f0-9]+)\t/.exec(row)
    if (match) {
      if (match[1] === '120000') return { kind: 'symlink', target: decodeTarget(relative, (await git(source, ['cat-file', 'blob', match[3]!], signal)).output) }
      return { kind: match[2] === 'tree' ? 'directory' : 'file' }
    }
    const target = path.join(source, relative)
    const info = await lstat(target).catch(() => undefined)
    if (info === undefined) return undefined
    if (info.isSymbolicLink()) return { kind: 'symlink', target: decodeTarget(relative, await readlink(target, { encoding: 'buffer' })) }
    return { kind: info.isDirectory() ? 'directory' : 'file' }
  }
}
function environment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' }
}
async function git(cwd: string, args: string[], signal?: AbortSignal, accepted = [0]): Promise<{ output: Buffer; code: number }> {
  signal?.throwIfAborted()
  return await new Promise((resolve, reject) => {
    execFile('git', ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd, env: environment(), encoding: 'buffer', timeout: 30_000, maxBuffer: MAX_BYTES, signal }, (error, stdout, stderr) => {
      const code = error && typeof error.code === 'number' ? error.code : error ? -1 : 0
      if (!accepted.includes(code)) reject(new Error(`Git delivery ${args[0]} failed: ${stderr.toString('utf8').trim() || error?.message || code}`))
      else resolve({ output: stdout, code })
    })
  })
}
async function validate(input: DeliveryInput, signal?: AbortSignal): Promise<{ source: string; gitDir: string; changedPaths: string[] }> {
  for (const commit of [input.baselineCommit, input.resultCommit]) if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error('Delivery requires immutable full Git commit IDs')
  const source = await realpath(input.source)
  if (source !== path.resolve(input.source)) throw new Error('Delivery source must be canonical, without symlinks')
  const top = (await git(source, ['rev-parse', '--show-toplevel'], signal)).output.toString('utf8').trim()
  if (top !== source) throw new Error('Delivery source must be the Git repository root')
  for (const commit of [input.baselineCommit, input.resultCommit]) if ((await git(source, ['cat-file', '-t', commit], signal)).output.toString('utf8').trim() !== 'commit') throw new Error('Delivery artifact must be a commit')
  const ancestor = await git(source, ['merge-base', '--is-ancestor', input.baselineCommit, input.resultCommit], signal, [0, 1])
  if (ancestor.code !== 0) throw new Error('Delivery result does not descend from its task snapshot')
  const names = (await git(source, ['diff', '--name-only', '--no-renames', '-z', input.baselineCommit, input.resultCommit, '--'], signal)).output
  const changedPaths = new TextDecoder('utf-8', { fatal: true }).decode(names).split('\0').filter(Boolean)
  changedPaths.forEach(validPath)
  const gitDir = await realpath((await git(source, ['rev-parse', '--absolute-git-dir'], signal)).output.toString('utf8').trim())
  return { source, gitDir, changedPaths }
}

/** The preview excludes the user's pre-existing changes by comparing snapshot to result. */
export async function inspectDelivery(input: DeliveryInput, signal?: AbortSignal): Promise<DeliveryInspection> {
  const { source, changedPaths } = await validate(input, signal)
  const output = (await git(source, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', input.baselineCommit, input.resultCommit, '--'], signal)).output
  return { baselineCommit: input.baselineCommit, resultCommit: input.resultCommit, changedPaths, diff: output.subarray(0, MAX_DIFF).toString('utf8'), truncated: output.length > MAX_DIFF }
}

/** Check each existing ancestor; a symlink is never traversed when inspecting/writing a file. */
async function parents(source: string, relative: string, create = false, created: string[] = []): Promise<void> {
  if (await realpath(source) !== source) throw new Error('Delivery source was replaced with a symlink')
  const sourceStat = await lstat(source)
  const identity = sourceIdentities.get(source)
  if (identity && identity !== `${sourceStat.dev}:${sourceStat.ino}`) throw new Error('Delivery source directory was replaced during application')
  let current = source
  for (const part of relative.split('/').slice(0, -1)) {
    current = path.join(current, part)
    let stat
    try { stat = await lstat(current) } catch (error) {
      if (!missing(error)) throw error
      if (!create) return
      await mkdir(current, { mode: 0o755 })
      created.push(current)
      stat = await lstat(current)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Delivery path has a non-directory or symlink parent: ${relative}`)
  }
}
function stamp(stat: Awaited<ReturnType<typeof lstat>>, bytes: Buffer): string {
  return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${sha(bytes)}`
}
async function local(source: string, relative: string): Promise<Local> {
  await parents(source, relative)
  const target = path.join(source, relative)
  let before
  try { before = await lstat(target) } catch (error) { if (missing(error)) return { fingerprint: 'absent' }; throw error }
  if (before.isDirectory()) return { fingerprint: stamp(before, Buffer.alloc(0)), directory: true }
  if (!before.isFile() && !before.isSymbolicLink()) throw new Error(`Unsupported delivery file type: ${relative}`)
  let bytes: Buffer
  if (before.isSymbolicLink()) bytes = await readlink(target, { encoding: 'buffer' })
  else {
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await file.stat()
      if (opened.size > MAX_BYTES) throw new Error(`Delivery file exceeds 64 MiB: ${relative}`)
      if (opened.ino !== before.ino || opened.dev !== before.dev || !opened.isFile()) throw new Error(`File changed while reading delivery: ${relative}`)
      bytes = await file.readFile()
    } finally { await file.close() }
  }
  const after = await lstat(target)
  if (stamp(before, bytes) !== stamp(after, bytes)) throw new Error(`File changed while reading delivery: ${relative}`)
  const entry: Entry = { kind: before.isSymbolicLink() ? 'symlink' : 'file', bytes, mode: before.isSymbolicLink() ? 0o120000 : (before.mode & 0o111) ? 0o100755 : 0o100644 }
  return { entry, fingerprint: stamp(after, bytes) }
}
async function treeEntry(source: string, commit: string, relative: string, signal?: AbortSignal): Promise<Entry | undefined> {
  const row = (await git(source, ['ls-tree', '-z', commit, '--', relative], signal)).output.toString('utf8')
  if (!row) return undefined
  const match = /^(\d+) (blob|tree|commit) ([a-f0-9]+)\t/.exec(row)
  if (!match || match[2] !== 'blob' || !['100644', '100755', '120000'].includes(match[1]!)) throw new Error(`Delivery does not support submodules or directory replacements: ${relative}`)
  const bytes = (await git(source, ['cat-file', 'blob', match[3]!], signal)).output
  return { kind: match[1] === '120000' ? 'symlink' : 'file', mode: parseInt(match[1]!, 8), bytes }
}
async function mergeEntry(base: Entry | undefined, current: Entry | undefined, result: Entry | undefined, temporary: string, signal?: AbortSignal): Promise<{ output?: Entry; conflict?: true }> {
  if (same(current, result) || same(base, result)) return { output: current }
  if (same(current, base)) return { output: result }
  if (!base || !current || !result || base.kind !== 'file' || current.kind !== 'file' || result.kind !== 'file') return { conflict: true }
  const mode = current.mode === result.mode ? current.mode : current.mode === base.mode ? result.mode : result.mode === base.mode ? current.mode : undefined
  if (mode === undefined) return { conflict: true }
  if (current.bytes.equals(result.bytes)) return { output: { ...current, mode } }
  if (current.bytes.equals(base.bytes)) return { output: { ...result, mode } }
  if (result.bytes.equals(base.bytes)) return { output: { ...current, mode } }
  if ([base, current, result].some(entry => entry.bytes.includes(0))) return { conflict: true }
  const files = ['current', 'base', 'result'].map(name => path.join(temporary, name))
  await Promise.all([current, base, result].map((entry, index) => writeFile(files[index]!, entry.bytes, { mode: 0o600 })))
  const merged = await git(temporary, ['merge-file', '-p', '-L', 'Local changes', '-L', 'Swarm snapshot', '-L', 'Swarm result', ...files], signal, Array.from({ length: 128 }, (_, i) => i))
  return merged.code === 0 ? { output: { kind: 'file', mode, bytes: merged.output } } : { conflict: true }
}
async function privateDirectory(gitDir: string): Promise<string> {
  const directory = path.join(gitDir, 'dsh-agent-swarm-delivery')
  await mkdir(directory, { mode: 0o700 }).catch(error => { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error })
  if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) throw new Error('Unsafe delivery metadata directory')
  return directory
}
/**
 * A lock without a readable owner is the crash window between `mkdir` and the
 * atomic owner rename, so it is reclaimable after this grace period. A readable
 * owner is reclaimable only when its pid is gone.
 */
const LOCK_GRACE_MS = 30_000
const LOCK_RETRIES = 5
async function lockOwner(lock: string): Promise<{ pid: number; createdAt?: number } | undefined> {
  try {
    const value = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8')) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const owner = value as { pid?: unknown; createdAt?: unknown }
    if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) return undefined
    return { pid: owner.pid as number, ...(Number.isSafeInteger(owner.createdAt) ? { createdAt: owner.createdAt as number } : {}) }
  } catch { return undefined }
}
function ownerAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (failure) { return !(failure instanceof Error && 'code' in failure && failure.code === 'ESRCH') }
}
async function lockStale(lock: string): Promise<boolean> {
  const owner = await lockOwner(lock)
  if (owner !== undefined) return !ownerAlive(owner.pid)
  const info = await lstat(lock).catch(() => undefined)
  return info === undefined || Date.now() - info.mtimeMs >= LOCK_GRACE_MS
}
async function acquire(directory: string): Promise<() => Promise<void>> {
  const lock = path.join(directory, 'apply.lock')
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(lock, { mode: 0o700 }); break } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      if (attempt >= LOCK_RETRIES - 1 || !(await lockStale(lock))) throw new Error('Another delivery is being applied to this project')
      // Reclaim atomically: the winner of the rename owns the removal, so two
      // contenders cannot both delete a lock the other just created.
      const discarded = `${lock}.stale-${randomUUID()}`
      try { await rename(lock, discarded); await rm(discarded, { recursive: true, force: true }) } catch { /* another contender reclaimed it first */ }
    }
  }
  const temporary = path.join(directory, `owner-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { mode: 0o600, flag: 'wx' })
    await rename(temporary, path.join(lock, 'owner.json'))
  } catch (error) {
    await rm(lock, { recursive: true, force: true }).catch(() => undefined)
    throw error
  } finally { await rm(temporary, { force: true }).catch(() => undefined) }
  return async () => { await rm(lock, { recursive: true, force: true }) }
}

async function restoreExclusive(backup: string, target: string): Promise<void> {
  // On macOS link() dereferences a symlink source; recreate the link itself instead.
  if ((await lstat(backup)).isSymbolicLink()) await symlink(await readlink(backup, { encoding: 'buffer' }), target)
  else await link(backup, target)
  await unlink(backup)
}

/** Preserve any edit that appeared after publication, including edits racing rollback. */
async function rollback(source: string, written: Written[]): Promise<string[]> {
  const retained: string[] = []
  for (const item of [...written].reverse()) {
    const relative = item.change.relative
    const target = path.join(source, relative)
    try {
      const now = await local(source, relative)
      if (item.published && now.fingerprint === item.published.fingerprint) {
        const displaced = `${target}.swarm-rollback-${randomUUID()}`
        await rename(target, displaced)
        const moved = await local(source, path.relative(source, displaced))
        // rename changes ctime, so compare identity/content rather than the full timestamp.
        if (!same(moved.entry, item.published.entry) || moved.fingerprint.split(':').slice(0, 2).join(':') !== item.published.fingerprint.split(':').slice(0, 2).join(':')) {
          await restoreExclusive(displaced, target).catch(() => { retained.push(displaced) })
          if (item.backup) retained.push(item.backup)
          continue
        }
        await unlink(displaced)
      } else if (now.fingerprint !== 'absent') {
        if (item.backup) retained.push(item.backup)
        continue
      }
      if (item.backup) await restoreExclusive(item.backup, target)
    } catch { if (item.backup) retained.push(item.backup) }
  }
  return retained
}

/** Three-way merge first; a conflicting plan never modifies any source file. */
export async function applyDelivery(input: DeliveryInput, signal?: AbortSignal): Promise<DeliveryApplication> {
  const { source, gitDir, changedPaths } = await validate(input, signal)
  if (activeSources.has(source)) throw new Error('Another delivery is being applied to this project')
  activeSources.add(source)
  let release: (() => Promise<void>) | undefined
  let temporary: string | undefined
  const written: Written[] = []
  const createdDirectories: string[] = []
  const temporaryFiles: string[] = []
  let completed = false
  try {
    const sourceStat = await lstat(source)
    sourceIdentities.set(source, `${sourceStat.dev}:${sourceStat.ino}`)
    const metadata = await privateDirectory(gitDir)
    release = await acquire(metadata)
    const receipt = path.join(metadata, `${sha(`${source}\0${input.baselineCommit}\0${input.resultCommit}`)}.json`)
    let receiptHit = false
    try {
      const saved = JSON.parse(await readFile(receipt, 'utf8')) as Record<string, unknown>
      if (saved.source === source && saved.baselineCommit === input.baselineCommit && saved.resultCommit === input.resultCommit && saved.applied === true) {
        receiptHit = true
        // A receipt is a hint, not proof: the working tree may have been
        // reverted or edited after the recorded apply. Re-check every changed
        // path against the recorded fingerprints and fall through to the
        // idempotent three-way merge on any mismatch. Legacy receipts without
        // fingerprints always fall through.
        const savedFingerprints = saved.fingerprints
        let unchanged = typeof savedFingerprints === 'object' && savedFingerprints !== null && !Array.isArray(savedFingerprints)
        if (unchanged) {
          const recorded = savedFingerprints as Record<string, unknown>
          for (const relative of changedPaths) {
            const expected = recorded[relative]
            if (typeof expected !== 'string') { unchanged = false; break }
            try { if ((await local(source, relative)).fingerprint !== expected) { unchanged = false; break } }
            catch { unchanged = false; break }
          }
        }
        if (unchanged) return { status: 'applied', changedPaths, conflicts: [] }
      }
    } catch (error) { if (!missing(error)) throw error }
    // R15-F5: delivery's scratch root uses the shared fallback policy, anchored
    // in its own private metadata directory (inside `.git`, so no scratch
    // directory is ever visible to capture as work).
    temporary = await tempDirectory('dsh-swarm-delivery-', path.join(metadata, 'tmp'))
    const changes: Change[] = []
    const conflicts: string[] = []
    const lookup = resultLookup(source, input.resultCommit, signal)
    for (const relative of changedPaths) {
      signal?.throwIfAborted()
      const original = await local(source, relative)
      if (original.directory) { conflicts.push(relative); continue }
      const base = await treeEntry(source, input.baselineCommit, relative, signal)
      const result = await treeEntry(source, input.resultCommit, relative, signal)
      // The result tree is what this call can materialize; a link whose
      // resolved chain escapes the repository is refused before any source
      // write, including a chain through a pre-existing escaping link (F-C1).
      if (result?.kind === 'symlink') await assertContainedSymlinkChain(relative, decodeTarget(relative, result.bytes), lookup, 'Delivery symlink escapes the repository')
      const merged = await mergeEntry(base, original.entry, result, temporary, signal)
      if (merged.conflict) {
        // A recorded apply already wrote this result. If the user has since
        // edited the path in a way that cannot merge cleanly, keep their work
        // instead of reporting a spurious conflict. The result is only
        // rewritten when it is definitively absent (the path was deleted).
        if (receiptHit && original.entry === undefined && result !== undefined) changes.push({ relative, original, output: result })
        else if (!receiptHit) conflicts.push(relative)
      } else if (!same(original.entry, merged.output)) changes.push({ relative, original, output: merged.output })
    }
    if (conflicts.length) return { status: 'conflicts', changedPaths, conflicts }
    // Check the whole write set before making the first modification.
    for (const change of changes) if ((await local(source, change.relative)).fingerprint !== change.original.fingerprint) throw new Error(`Local file changed during delivery: ${change.relative}`)
    for (const change of changes) {
      signal?.throwIfAborted()
      await parents(source, change.relative, true, createdDirectories)
      const target = path.join(source, change.relative)
      let staged: string | undefined
      if (change.output?.kind === 'file') {
        staged = `${target}.swarm-pending-${randomUUID()}`
        temporaryFiles.push(staged)
        await writeFile(staged, change.output.bytes, { mode: change.output.mode & 0o777, flag: 'wx' })
        await chmod(staged, change.output.mode & 0o777)
      }
      if ((await local(source, change.relative)).fingerprint !== change.original.fingerprint) throw new Error(`Local file changed during delivery: ${change.relative}`)
      const item: Written = { change }
      written.push(item)
      if (change.original.entry) {
        const backup = `${target}.swarm-backup-${randomUUID()}`
        await rename(target, backup)
        item.backup = backup
        const moved = await local(source, path.relative(source, item.backup))
        if (!same(moved.entry, change.original.entry) || moved.fingerprint.split(':').slice(0, 2).join(':') !== change.original.fingerprint.split(':').slice(0, 2).join(':')) throw new Error(`Local file changed during delivery: ${change.relative}`)
      }
      if (change.output) {
        // Hard-link publication is exclusive: a racing editor's new file is never overwritten.
        await parents(source, change.relative)
        if (change.output.kind === 'symlink') await symlink(change.output.bytes, target)
        else await link(staged!, target)
        const published = await local(source, change.relative)
        if (!same(published.entry, change.output)) throw new Error(`Local file changed while publishing delivery: ${change.relative}`)
        item.published = published
        if (staged) await unlink(staged)
        // Removing the staging hard link changes ctime.
        const afterUnlink = await local(source, change.relative)
        if (!same(afterUnlink.entry, change.output)) throw new Error(`Local file changed while publishing delivery: ${change.relative}`)
        item.published = afterUnlink
      }
    }
    signal?.throwIfAborted()
    for (const item of written) {
      const now = await local(source, item.change.relative)
      if (item.published ? now.fingerprint !== item.published.fingerprint : now.fingerprint !== 'absent') throw new Error(`Local file changed while applying delivery: ${item.change.relative}`)
      // An editor may still hold an open descriptor to the original, renamed file.
      if (item.backup && !same((await local(source, path.relative(source, item.backup))).entry, item.change.original.entry)) throw new Error(`Original file changed while applying delivery: ${item.change.relative}`)
    }
    // Record the exact applied state per changed path so a later call can tell
    // a genuinely applied tree from a stale receipt.
    const fingerprints: Record<string, string> = {}
    for (const relative of changedPaths) fingerprints[relative] = (await local(source, relative)).fingerprint
    const pendingReceipt = `${receipt}.${randomUUID()}.tmp`
    temporaryFiles.push(pendingReceipt)
    await writeFile(pendingReceipt, JSON.stringify({ ...input, source, applied: true, changedPaths, fingerprints }), { mode: 0o600, flag: 'wx' })
    await rename(pendingReceipt, receipt)
    completed = true
    for (const item of written) if (item.backup) await unlink(item.backup).catch(() => undefined)
    return { status: 'applied', changedPaths, conflicts: [] }
  } catch (error) {
    if (!completed && written.length) {
      const retained = await rollback(source, written)
      if (retained.length) throw new Error(`Delivery stopped; later local edits were preserved. Recovery copies: ${retained.join(', ')}`, { cause: error })
    }
    throw error
  } finally {
    for (const file of temporaryFiles) await unlink(file).catch(() => undefined)
    for (const directory of createdDirectories.reverse()) await rmdir(directory).catch(() => undefined)
    if (temporary) await rm(temporary, { recursive: true, force: true })
    try { await release?.() } finally { activeSources.delete(source); sourceIdentities.delete(source) }
  }
}
