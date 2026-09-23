/**
 * Pure helpers behind update-preview's snapshot summary: `summarizePaths` and
 * `changedPaths` hash every packaged path in the sync entry list, so a sync that
 * replaces ten files and adds two missing modules no longer reports a single
 * changed file (R7-03).
 *
 * Nothing here writes, spawns or mutates shared state; the only reads are the
 * filesystem reads `summarizePaths` needs to hash the packaged bytes. Which
 * launch URL belongs to the new host is no longer a question: scripts/host.mjs
 * gives every boot a fresh server.log.
 */
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join, sep } from 'node:path'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const toPosix = path => path.split(sep).join('/')

/**
 * Hash every packaged path reachable from `entries`, relative to `pluginDir`.
 *
 * An entry may be a file or a directory; directories are expanded recursively
 * so `lib` covers every module the build produced, including one that did not
 * exist in the previous snapshot. A path missing on this side is simply absent
 * from the result — `changedPaths` treats "absent" as a difference, which is
 * how a newly added module or a removed one gets reported. Symlinks are hashed
 * by their target string, matching `cpSync`'s default of copying the link
 * rather than the referent, and keeping the walk loop-free.
 */
export function summarizePaths(pluginDir, entries) {
  const summary = {}
  for (const entry of entries ?? []) collect(join(pluginDir, entry), entry, summary)
  return summary
}

function collect(path, relative, summary) {
  let stat
  try { stat = lstatSync(path) } catch { return } // missing entry: omitted on this side
  if (stat.isSymbolicLink()) { summary[toPosix(relative)] = sha256(readlinkSync(path)); return }
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) collect(join(path, name), join(relative, name), summary)
    return
  }
  if (stat.isFile()) summary[toPosix(relative)] = sha256(readFileSync(path))
}

/**
 * Sorted paths whose bytes differ between two `summarizePaths` results. A path
 * present on only one side counts as changed, so a missing module is reported
 * instead of silently dropped; identical paths are omitted, so "no difference"
 * yields an empty list.
 */
export function changedPaths(before, after) {
  const paths = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  return [...paths].filter(path => before?.[path] !== after?.[path]).sort()
}
