/**
 * Pure helpers behind the two host-lifecycle decisions in `update-preview.mjs`.
 *
 * They live here, with no side effects, so the restart worker's fragile parts
 * can be unit-tested without a live preview host:
 *   - `selectLaunchUrl` picks the token of the host that was *just* started out
 *     of an append-only `server.log` that still contains every previous host's
 *     token (R7-02);
 *   - `summarizePaths`/`changedPaths` hash every packaged path in the sync
 *     entry list, so a sync that replaces ten files and adds two missing
 *     modules no longer reports a single changed file (R7-03).
 *
 * Nothing here writes, spawns or mutates shared state; the only reads are the
 * filesystem reads `summarizePaths` needs to hash the packaged bytes.
 */
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join, sep } from 'node:path'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const toPosix = path => path.split(sep).join('/')

/** The launch-URL shape the host prints, anchored to one port. */
export function launchUrlPattern(port) {
  return new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[A-Za-z0-9_.-]+`, 'g')
}

/**
 * Select the launch URL of the host started after `sinceOffset` characters of
 * `logText`, or `undefined` when that host has not printed one yet.
 *
 * `server.log` is append-only and keeps every previous host's token, so a
 * whole-file match returns the *previous* host's URL before the new host has
 * printed anything, and the documented link then returns 401. Only matches at
 * or after `sinceOffset` — the log length captured before the new host was
 * spawned — can belong to the new host.
 *
 * `sinceOffset` 0 (no prior token, or a caller that wants the whole file)
 * reproduces the pre-fix selection exactly.
 */
export function selectLaunchUrl(logText, sinceOffset, port) {
  if (typeof logText !== 'string' || logText.length === 0) return undefined
  const offset = Number.isInteger(sinceOffset) && sinceOffset > 0 ? sinceOffset : 0
  const found = logText.slice(offset).match(launchUrlPattern(port))
  return found ? found.at(-1) : undefined
}

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
