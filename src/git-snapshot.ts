/** Immutable worktree snapshots made with a private Git index. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type SnapshotGit = (args: string[], env?: Record<string, string>) => Promise<string>
export interface GitSnapshot {
  sourceHead: string
  snapshotCommit: string
  changedPaths: string[]
  createdAt: number
}
interface SourceState {
  head: string
  fingerprint: string
  stagedOnly: string[]
}
class ChangedDuringSnapshot extends Error {}
const paths = (value: string): string[] => value.split('\0').filter(Boolean)

async function digestFile(file: string, signal?: AbortSignal): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file, { signal })) digest.update(chunk)
  return digest.digest('hex')
}

async function sourceState(source: string, git: SnapshotGit, signal?: AbortSignal): Promise<SourceState> {
  const head = await git(['rev-parse', 'HEAD^{commit}'])
  if (await git(['ls-files', '--unmerged', '-z'])) throw new Error('Resolve Git merge conflicts before creating a swarm snapshot')
  const sparse = await git(['config', '--bool', '--get', 'core.sparseCheckout']).catch(() => '')
  if (sparse === 'true') throw new Error('Swarm snapshots do not yet support sparse checkouts')
  const indexFile = path.resolve(source, await git(['rev-parse', '--git-path', 'index']))
  const index = await readFile(indexFile).catch(error => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return Buffer.alloc(0)
    throw error
  })
  const headEntries = paths(await git(['ls-tree', '-rz', '--full-tree', head]))
  const tracked = paths(await git(['ls-files', '--cached', '-z']))
  const trackedSet = new Set(tracked)
  const untracked = paths(await git(['ls-files', '--others', '--exclude-standard', '-z']))
  const headPaths = new Set(headEntries.map(entry => entry.slice(entry.indexOf('\t') + 1)))
  const submodules = new Map(headEntries.filter(entry => entry.startsWith('160000 ')).map(entry => {
    const tab = entry.indexOf('\t')
    return [entry.slice(tab + 1), entry.slice(0, tab).split(' ')[2]!]
  }))
  const digest = createHash('sha256').update(head).update('\0').update(index)
  const stagedOnly: string[] = []
  for (const filename of [...new Set([...headPaths, ...tracked, ...untracked])].sort()) {
    signal?.throwIfAborted()
    if (filename.endsWith('/')) throw new Error(`Nested repositories cannot be captured as swarm snapshots: ${filename}`)
    const absolute = path.join(source, filename)
    let blockedAncestor = false
    for (let parent = path.dirname(filename); parent !== '.'; parent = path.dirname(parent)) {
      const parentStat = await lstat(path.join(source, parent)).catch(() => undefined)
      if (parentStat === undefined || !parentStat.isDirectory()) { blockedAncestor = true; break }
    }
    const stat = blockedAncestor ? undefined : await lstat(absolute).catch(error => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    })
    digest.update(JSON.stringify([filename, stat?.mode ?? null]))
    if (stat === undefined) continue
    if (submodules.has(filename)) {
      // A clean gitlink is preserved; dirty or moved submodule state has no
      // faithful single-repository snapshot representation.
      const nestedHead = await git(['-C', absolute, 'rev-parse', 'HEAD^{commit}'])
      const nestedStatus = await git(['-C', absolute, 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])
      if (nestedHead !== submodules.get(filename) || nestedStatus) throw new Error(`Dirty submodule cannot be captured in a swarm snapshot: ${filename}`)
      digest.update(nestedHead)
    } else if (stat.isSymbolicLink()) digest.update(await readlink(absolute))
    else if (stat.isFile()) {
      try { digest.update(await digestFile(absolute, signal)) }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new ChangedDuringSnapshot()
        throw error
      }
    } else if (stat.isDirectory()) {
      if (await lstat(path.join(absolute, '.git')).then(() => true, () => false)) throw new Error(`Nested repository cannot be captured in a swarm snapshot: ${filename}`)
    } else throw new Error(`Unsupported snapshot file type: ${filename}`)
    if ((stat.isFile() || stat.isSymbolicLink()) && trackedSet.has(filename) && !headPaths.has(filename)) stagedOnly.push(filename)
    digest.update('\0')
  }
  return { head, fingerprint: digest.digest('hex'), stagedOnly }
}

/** Capture stable tracked and nonignored untracked content without touching the real index. */
export async function captureGitSnapshot(source: string, directory: string, git: SnapshotGit, signal?: AbortSignal): Promise<GitSnapshot> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted()
    const index = path.join(directory, `snapshot-index-${randomUUID()}`)
    const forcedPaths = `${index}.paths`
    let before: SourceState | undefined
    try {
      before = await sourceState(source, git, signal)
      const env = { GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: '1' }
      await git(['read-tree', before.head], env)
      await git(['add', '--all', '--', '.'], env)
      // Already-tracked additions may match ignore rules. They remain part of
      // the user's working state even though a fresh private index lacks them.
      if (before.stagedOnly.length) {
        await writeFile(forcedPaths, before.stagedOnly.join('\0') + '\0', { mode: 0o600, flag: 'wx' })
        await git(['add', '--force', `--pathspec-from-file=${forcedPaths}`, '--pathspec-file-nul'], env)
      }
      const tree = await git(['write-tree'], env)
      const after = await sourceState(source, git, signal)
      if (before.fingerprint !== after.fingerprint) continue
      const originalTree = await git(['rev-parse', `${before.head}^{tree}`])
      const snapshotCommit = tree === originalTree ? before.head : await git(['commit-tree', tree, '-p', before.head, '-m', 'Agent Swarm private workspace baseline'])
      const changedPaths = paths(await git(['diff', '--name-only', '-z', before.head, snapshotCommit, '--']))
      return { sourceHead: before.head, snapshotCommit, changedPaths, createdAt: Date.now() }
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof ChangedDuringSnapshot) continue
      // A disappearing path may make Git itself reject the add. Retry only
      // when the observed source actually changed; preserve genuine failures.
      if (before !== undefined && await sourceState(source, git, signal).then(after => after.fingerprint !== before!.fingerprint, () => false)) continue
      throw error
    } finally {
      await rm(index, { force: true })
      await rm(`${index}.lock`, { force: true })
      await rm(forcedPaths, { force: true })
    }
  }
  throw new Error('Workspace kept changing while creating its snapshot; retry after the current edits settle')
}
